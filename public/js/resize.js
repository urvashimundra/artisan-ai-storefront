/* Photo resize helper for the product upload page. Progressive enhancement: if anything here fails, the caller uploads
   the original file unchanged. Downsizes to at most 1200 px on the long side and re-encodes as JPEG (quality 0.82),
   which also drops EXIF and GPS data. The server never trusts this: type, size and content are validated again there. */
(function (global) {
  var MAX_SIDE = 1200;
  var JPEG_QUALITY = 0.82;

  /** Pure: target size that fits the long side within maxSide, keeping the aspect ratio and never enlarging. */
  function fitWithin(width, height, maxSide) {
    var longest = Math.max(width, height);
    if (longest <= maxSide) return { width: width, height: height };
    var scale = maxSide / longest;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  /** Decodes with EXIF orientation applied (so phone photos stay upright), draws on white, encodes as JPEG. */
  function resizeToJpeg(file) {
    return global.createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
      var size = fitWithin(bitmap.width, bitmap.height, MAX_SIDE);
      var canvas = global.document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      var context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      if (bitmap.close) bitmap.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) { return blob ? resolve(blob) : reject(new Error('encode')); }, 'image/jpeg', JPEG_QUALITY);
      });
    });
  }

  var api = { MAX_SIDE: MAX_SIDE, JPEG_QUALITY: JPEG_QUALITY, fitWithin: fitWithin, resizeToJpeg: resizeToJpeg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ArtisanResize = api;
})(typeof window !== 'undefined' ? window : globalThis);
