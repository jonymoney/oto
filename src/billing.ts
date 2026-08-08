import Stripe from 'stripe'
import { config } from './config.js'
import { usageRepo } from './db.js'

// Lazy singleton — only constructed when billing is configured. Callers gate on
// config.billingEnabled before hitting these, so the non-null assertions on the
// Stripe secrets are safe.
let client: Stripe | null = null
function stripe(): Stripe {
  if (!client) client = new Stripe(config.STRIPE_SECRET_KEY!)
  return client
}

const origin = new URL(config.MCP_SERVER_URL).origin

/** Create a subscription Checkout Session and return its hosted URL. */
export async function createCheckoutSession(userId: string, email?: string): Promise<string> {
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.STRIPE_PRICE_ID!, quantity: 1 }],
    client_reference_id: userId,
    metadata: { userId },
    ...(email ? { customer_email: email } : {}),
    success_url: `${origin}/upgrade?status=success`,
    cancel_url: `${origin}/upgrade?status=cancel`,
  })
  if (!session.url) throw new Error('Stripe returned a checkout session without a URL')
  return session.url
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
      await usageRepo.setSubscriptionStatus(customerId, status, isPaid(status))
      return
    }
    default:
      return // ignore everything else
  }
}
