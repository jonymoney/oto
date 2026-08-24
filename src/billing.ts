import Stripe from 'stripe'
import { config } from './config.js'
import { pool, usageRepo } from './db.js'

// Lazy singleton — only constructed when billing is configured. Callers gate on
// config.billingEnabled before hitting these, so the non-null assertions on the
// Stripe secrets are safe.
let client: Stripe | null = null
function stripe(): Stripe {
  if (!client) client = new Stripe(config.STRIPE_SECRET_KEY!)
  return client
}

const origin = new URL(config.MCP_SERVER_URL).origin

// ponytail: db.ts has setters for these columns but no per-user reader — a
// targeted query here beats editing a module another agent owns.
async function billingRow(
  userId: string,
): Promise<{ customerId: string | null; status: string | null; unlimited: boolean }> {
  const { rows } = await pool.query<{
    stripe_customer_id: string | null
    subscription_status: string | null
    unlimited: boolean
  }>(
    'select stripe_customer_id, subscription_status, unlimited from usage_counters where user_id = $1',
    [userId],
  )
  const row = rows[0]
  return {
    customerId: row?.stripe_customer_id ?? null,
    status: row?.subscription_status ?? null,
    unlimited: row?.unlimited ?? false,
  }
}

/** Create a Stripe billing portal session for the user and return its URL. */
export async function createPortalSession(userId: string): Promise<string> {
  const { customerId } = await billingRow(userId)
  if (!customerId) throw new Error('No Stripe customer for this user — nothing to manage yet')
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/upgrade`,
  })
  return session.url
}

/**
 * Create a subscription Checkout Session and return its hosted URL.
 * If the user already has an active "oto unlimited" subscription, this returns
 * a billing-portal URL instead — never a second subscription.
 */
export async function createCheckoutSession(userId: string, email?: string): Promise<string> {
  const { customerId, status, unlimited } = await billingRow(userId)
  if (unlimited && customerId && isPaid(status ?? '')) {
    return createPortalSession(userId)
  }
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.STRIPE_PRICE_ID!, quantity: 1 }],
    client_reference_id: userId,
    metadata: { userId },
    automatic_tax: { enabled: true },
    ...(email ? { customer_email: email } : {}),
    success_url: `${origin}/upgrade?status=success`,
    cancel_url: `${origin}/upgrade?status=cancel`,
  })
  if (!session.url) throw new Error('Stripe returned a checkout session without a URL')
  return session.url
}

// Price display string ("$6.99/month") for the paywall — fetched from Stripe
// once and cached for the process lifetime (price changes mean a new price id
// and a deploy anyway).
let cachedPrice: string | null = null
export async function priceDisplay(): Promise<string | null> {
  if (cachedPrice) return cachedPrice
  const price = await stripe().prices.retrieve(config.STRIPE_PRICE_ID!)
  if (typeof price.unit_amount !== 'number') return null
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency.toUpperCase(),
  }).format(price.unit_amount / 100)
  cachedPrice = price.recurring ? `${amount}/${price.recurring.interval}` : amount
  return cachedPrice
}

// A subscription is "paid" only while active or trialing.
const isPaid = (status: string): boolean => status === 'active' || status === 'trialing'

/** Verify + apply a Stripe webhook event. Idempotent (safe to receive twice). */
export async function handleWebhookEvent(rawBody: Buffer, signature: string): Promise<void> {
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET!)

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      const userId = session.client_reference_id ?? session.metadata?.userId
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id
      if (!userId || !customerId) return
      await usageRepo.linkStripeCustomer(userId, customerId)
      await usageRepo.setUnlimited(userId, true)
      await usageRepo.setSubscriptionStatus(customerId, 'active', true)
      return
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
      if (!customerId) return
      // deleted events can arrive with status 'active'; treat the event type as canceled.
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status
      // Out-of-order guard: an 'updated' event arriving after the delete has
      // been stored must not re-activate a canceled subscription. A genuine
      // re-subscribe goes through checkout.session.completed, which resets
      // the stored status to 'active' first.
      if (event.type === 'customer.subscription.updated' && isPaid(status)) {
        const { rows } = await pool.query<{ subscription_status: string | null }>(
          'select subscription_status from usage_counters where stripe_customer_id = $1',
          [customerId],
        )
        if (rows[0]?.subscription_status === 'canceled') return
      }
      await usageRepo.setSubscriptionStatus(customerId, status, isPaid(status))
      return
    }
    default:
      return // ignore everything else
  }
}
