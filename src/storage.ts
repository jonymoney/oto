import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from './config.js'

// Railway Buckets use virtual-hosted-style URLs (bucket name as subdomain of
// storage.railway.app), so forcePathStyle stays off — only legacy pre-change
// buckets need path-style (see docs.railway.com/storage-buckets).
const s3 = new S3Client({
  endpoint: config.BUCKET_ENDPOINT,
  region: config.BUCKET_REGION,
  credentials: {
    accessKeyId: config.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: config.BUCKET_SECRET_ACCESS_KEY,
  },
})

export async function putAudio(
  objectKey: string,
  body: Buffer,
  contentType = 'audio/mpeg',
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.BUCKET_NAME,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  )
}

/** True iff the object exists in the bucket. 404/NotFound → false; other errors rethrow. */
export async function audioObjectExists(objectKey: string): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: config.BUCKET_NAME, Key: objectKey }),
    )
    return true
  } catch (err) {
    // HEAD errors carry no body, so the SDK identifies a missing object by the
    // modeled NotFound exception name or the raw 404 status in $metadata.
    if (
      err instanceof S3ServiceException &&
      (err.name === 'NotFound' || err.$metadata.httpStatusCode === 404)
    ) {
      return false
    }
    throw err
  }
}

export async function presignAudioUrl(objectKey: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.BUCKET_NAME, Key: objectKey }),
    { expiresIn: config.AUDIO_URL_TTL_SECONDS },
  )
}

export async function deleteAudioObject(objectKey: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: config.BUCKET_NAME, Key: objectKey }),
  )
}
