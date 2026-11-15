import { IMAGE_BUCKET, MAX_IMAGE_BYTES, isOwnedImagePath } from '../domain/imageUpload.js';
import { AppError } from '../lib/errors.js';
import { requireStoreId } from './requireStoreId.js';

const HTTP_BAD_GATEWAY = 502;
export const SIGNED_URL_TTL_SECONDS = 300;

function storageFailure(operation) {
  return new AppError('STORAGE_ERROR', HTTP_BAD_GATEWAY, 'We could not reach photo storage. Please try again.', { operation });
}

/** Refuses any path outside `{storeId}/{productId}/`, so a caller can never touch another store's objects. */
function assertOwnedPath(path, storeId, productId) {
  if (!isOwnedImagePath(path, requireStoreId(storeId), productId)) throw new TypeError('Path is outside the product prefix');
}

/**
 * Private product photo storage. The bucket is private: nothing is public, and display uses short-lived signed
 * URLs. Every method takes storeId first and only works on paths inside that store's and product's prefix.
 * Provider messages are never forwarded.
 * @param {{ client: any, bucket?: string }} deps A Supabase client built with the storage timeout.
 */
export function createImageStorageRepository({ client, bucket = IMAGE_BUCKET }) {
  const files = () => client.storage.from(bucket);

  return {
    /** Stores `bytes` at `path`. Never overwrites. @throws {AppError} STORAGE_ERROR */
    async upload(storeId, productId, path, bytes, contentType) {
      assertOwnedPath(path, storeId, productId);
      const { error } = await files().upload(path, bytes, { contentType, upsert: false });
      if (error) throw storageFailure('upload');
    },

    /** @returns {Promise<Buffer>} @throws {AppError} STORAGE_ERROR, also for an object above the size limit. */
    async download(storeId, productId, path) {
      assertOwnedPath(path, storeId, productId);
      const { data, error } = await files().download(path);
      if (error || !data) throw storageFailure('download');
      const bytes = Buffer.from(await data.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw storageFailure('download_size');
      return bytes;
    },

    /** Deletes one object. @throws {AppError} STORAGE_ERROR */
    async remove(storeId, productId, path) {
      assertOwnedPath(path, storeId, productId);
      const { error } = await files().remove([path]);
      if (error) throw storageFailure('remove');
    },

    /** @returns {Promise<string>} A signed URL valid for SIGNED_URL_TTL_SECONDS. @throws {AppError} STORAGE_ERROR */
    async createSignedUrl(storeId, productId, path) {
      assertOwnedPath(path, storeId, productId);
      const { data, error } = await files().createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) throw storageFailure('sign');
      return data.signedUrl;
    },
  };
}
