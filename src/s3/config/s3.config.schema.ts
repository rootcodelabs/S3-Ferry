import * as joi from 'joi';

const schema = {
  S3_REGION: joi.string().default('us-east-1'),
  S3_ENDPOINT_URL: joi.string().uri().allow(''),
  S3_ACCESS_KEY_ID: joi.string().required(),
  S3_SECRET_ACCESS_KEY: joi.string().required(),
  S3_DATA_BUCKET_NAME: joi.string().required(),
  S3_DATA_BUCKET_PATH: joi.string().allow(''),
  S3_QUARANTINED_BUCKET_NAME: joi.string().default('quarantined'),
  S3_FLAGGED_BUCKET_NAME: joi.string().default('flagged'),
};

export const s3ConfigSchema = joi.object<typeof schema>(schema);
