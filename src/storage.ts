import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
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
