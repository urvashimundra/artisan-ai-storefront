import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors.js';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_BUCKET = 'product-images';

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const RIFF = Buffer.from('RIFF', 'ascii');
const WEBP = Buffer.from('WEBP', 'ascii');
const WEBP_HEADER_BYTES = 12;
const RIFF_SIZE_OFFSET = 4;
const RIFF_SIZE_FIELD_AND_TAG = 8;
const MIN_IMAGE_BYTES = 32;

/** Detected formats. The content type and extension come only from here, never from the client. */
const JPEG = Object.freeze({ contentType: 'image/jpeg', extension: 'jpg' });
const PNG = Object.freeze({ contentType: 'image/png', extension: 'png' });
const WEBP_TYPE = Object.freeze({ contentType: 'image/webp', extension: 'webp' });

export const ALLOWED_IMAGE_EXTENSIONS = Object.freeze([JPEG.extension, PNG.extension, WEBP_TYPE.extension]);

const startsWith = (buffer, signature, offset = 0) =>
  buffer.length >= offset + signature.length && buffer.subarray(offset, offset + signature.length).equals(signature);

const endsWith = (buffer, tail) => buffer.length >= tail.length && buffer.subarray(buffer.length - tail.length).equals(tail);

function isWebp(buffer) {
  if (!startsWith(buffer, RIFF) || !startsWith(buffer, WEBP, WEBP_HEADER_BYTES - WEBP.length)) return false;
  return buffer.readUInt32LE(RIFF_SIZE_OFFSET) + RIFF_SIZE_FIELD_AND_TAG === buffer.length;
}

/**
 * Detects the image format from magic bytes and a minimal completeness check (JPEG ends with EOI, PNG ends with
 * IEND, WebP's RIFF size matches), so truncated files are rejected. It does not decode the image.
 * @param {Buffer} buffer
 * @returns {{ contentType: string, extension: string } | null} null when unsupported or truncated.
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) return null;
  if (startsWith(buffer, JPEG_SIGNATURE)) return endsWith(buffer, JPEG_END) ? JPEG : null;
  if (startsWith(buffer, PNG_SIGNATURE)) return endsWith(buffer, PNG_IEND_CHUNK) ? PNG : null;
  return isWebp(buffer) ? WEBP_TYPE : null;
}

/**
 * Validates an uploaded body and returns its detected type. Client headers and filenames are never consulted.
 * @param {unknown} body Result of express.raw: a Buffer, or an empty object when nothing was sent.
 * @returns {{ contentType: string, extension: string }}
 * @throws {AppError} INVALID_IMAGE (400, 415) or IMAGE_TOO_LARGE (413).
 */
export function assertValidImage(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new AppError('INVALID_IMAGE', HTTP_BAD_REQUEST, 'Please choose a photo to upload.');
  }
  if (body.length > MAX_IMAGE_BYTES) {
    throw new AppError('IMAGE_TOO_LARGE', HTTP_PAYLOAD_TOO_LARGE, 'That photo is too large. The limit is 4 MB.');
  }
  const detected = detectImageType(body);
  if (!detected) {
    throw new AppError('INVALID_IMAGE', HTTP_UNSUPPORTED_MEDIA_TYPE, 'Please upload a complete JPEG, PNG or WebP photo.');
  }
  return detected;
}

/** Storage prefix that every object of one product lives under: `{storeId}/{productId}/`. */
export function imagePrefix(storeId, productId) {
  assertUuid(storeId);
  assertUuid(productId);
  return `${storeId}/${productId}/`;
}

/**
 * Builds the Storage object path `{storeId}/{productId}/{randomUUID}.{ext}`.
 * @param {{ storeId: string, productId: string, extension: string, randomId?: string }} parts
 * @returns {string}
 * @throws {TypeError} For a non-UUID id or an extension outside the allow-list.
 */
export function buildImagePath({ storeId, productId, extension, randomId = randomUUID() }) {
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension)) throw new TypeError('Unsupported image extension');
  assertUuid(randomId);
  return `${imagePrefix(storeId, productId)}${randomId}.${extension}`;
}

/** True when `path` is a well-formed object path inside this store's and product's prefix. */
export function isOwnedImagePath(path, storeId, productId) {
  if (typeof path !== 'string' || !path.startsWith(imagePrefix(storeId, productId))) return false;
  const name = path.slice(imagePrefix(storeId, productId).length);
  const [id, extension, ...rest] = name.split('.');
  return rest.length === 0 && UUID_PATTERN.test(id) && ALLOWED_IMAGE_EXTENSIONS.includes(extension);
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError('Expected a UUID');
}
