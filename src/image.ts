import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export interface Rect {
  x: number;
  y: number;
  w?: number;
  h?: number;
  width?: number;
  height?: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  /** Crop to this element ref's bounds (resolved via `get <ref> --property bounds`). */
  ref?: string;
  /** Extra pixels around the cropped ref/rect (clamped to image bounds). Default 0. */
  padding?: number;
  /** Crop to an explicit rect relative to the captured window/image. */
  rect?: Rect;
  /** Downscale proportionally if width exceeds maxWidth. */
  maxWidth?: number;
  /** Downscale factor in (0, 1], e.g. 0.5 halves width and height. */
  scale?: number;
  /** Output image format (default 'png'). */
  format?: 'png' | 'jpeg';
  /** JPEG quality 1-100 (default 80; only used when format === 'jpeg'). */
  quality?: number;
}

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** Normalize {x,y,w,h} or {x,y,width,height} into {x,y,width,height}. */
export function normalizeRect(rect: Rect): Bounds | undefined {
  const width = rect.w ?? rect.width;
  const height = rect.h ?? rect.height;
  if (
    !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
    width === undefined || height === undefined ||
    !Number.isFinite(width) || !Number.isFinite(height)
  ) {
    return undefined;
  }
  return { x: rect.x, y: rect.y, width, height };
}

/** Validate screenshot options; returns an error message or undefined if valid. */
export function validateScreenshotOptions(opts?: ScreenshotOptions): string | undefined {
  if (!opts) return undefined;
  if (opts.ref !== undefined && opts.rect !== undefined) {
    return 'screenshot options cannot specify both ref and rect.';
  }
  if (opts.ref !== undefined && (typeof opts.ref !== 'string' || !opts.ref.trim())) {
    return 'screenshot.ref must be a non-empty ref string.';
  }
  if (opts.padding !== undefined && (!Number.isFinite(opts.padding) || opts.padding < 0)) {
    return 'screenshot.padding must be a non-negative finite number.';
  }
  if (opts.rect !== undefined) {
    const r = normalizeRect(opts.rect);
    if (!r || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0) {
      return 'screenshot.rect must have finite x >= 0, y >= 0, and positive w/width and h/height.';
    }
  }
  if (opts.maxWidth !== undefined && (!Number.isInteger(opts.maxWidth) || opts.maxWidth < 1)) {
    return 'screenshot.maxWidth must be an integer >= 1.';
  }
  if (opts.scale !== undefined && (!Number.isFinite(opts.scale) || opts.scale <= 0 || opts.scale > 1)) {
    return 'screenshot.scale must be a finite number in (0, 1].';
  }
  if (opts.format !== undefined && opts.format !== 'png' && opts.format !== 'jpeg') {
    return 'screenshot.format must be "png" or "jpeg".';
  }
  if (opts.quality !== undefined && (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100)) {
    return 'screenshot.quality must be a finite number between 1 and 100.';
  }
  return undefined;
}

/** Read PNG width and height from IHDR without decoding pixel data. */
export function readPngDimensions(pngBuffer: Buffer): { width: number; height: number } | undefined {
  if (pngBuffer.length < 24 || pngBuffer.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: pngBuffer.readUInt32BE(16), height: pngBuffer.readUInt32BE(20) };
}

function cropRgba(src: Buffer, srcW: number, srcH: number, rect: Bounds, padding: number): { data: Buffer; width: number; height: number } {
  const x0 = Math.max(0, Math.floor(rect.x - padding));
  const y0 = Math.max(0, Math.floor(rect.y - padding));
  const x1 = Math.min(srcW, Math.ceil(rect.x + rect.width + padding));
  const y1 = Math.min(srcH, Math.ceil(rect.y + rect.height + padding));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) {
    throw new Error(`crop region (${x0},${y0} ${width}x${height}) is outside captured image (${srcW}x${srcH}).`);
  }
  const data = Buffer.allocUnsafe(width * height * 4);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const srcStart = ((y0 + row) * srcW + x0) * 4;
    src.copy(data, row * rowBytes, srcStart, srcStart + rowBytes);
  }
  return { data, width, height };
}

function resizeRgbaBilinear(src: Buffer, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
  const dst = Buffer.allocUnsafe(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(srcH - 1, (dy + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = sy - y0;
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(srcW - 1, (dx + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = sx - x0;
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const out = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        dst[out + c] = Math.round(src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11);
      }
    }
  }
  return dst;
}

/** Crop, downscale, and/or re-encode a captured PNG buffer according to ScreenshotOptions. */
export function processScreenshot(pngBuffer: Buffer, opts?: ScreenshotOptions, resolvedCrop?: Bounds): ProcessedImage {
  const format = opts?.format ?? 'png';
  const cropRect = resolvedCrop ?? (opts?.rect ? normalizeRect(opts.rect) : undefined);
  const hasScale = opts?.scale !== undefined && opts.scale < 1;
  const hasMaxWidth = opts?.maxWidth !== undefined;
  if (!cropRect && !hasScale && !hasMaxWidth && format === 'png') {
    const dims = readPngDimensions(pngBuffer);
    return { buffer: pngBuffer, mimeType: 'image/png', width: dims?.width ?? 0, height: dims?.height ?? 0 };
  }

  const decoded = PNG.sync.read(pngBuffer);
  let { data, width, height } = decoded;

  if (cropRect) {
    const cropped = cropRgba(data, width, height, cropRect, opts?.padding ?? 0);
    data = cropped.data;
    width = cropped.width;
    height = cropped.height;
  }

  let factor = opts?.scale ?? 1;
  if (opts?.maxWidth && width * factor > opts.maxWidth) {
    factor = opts.maxWidth / width;
  }
  if (factor < 1) {
    const dstW = Math.max(1, Math.round(width * factor));
    const dstH = Math.max(1, Math.round(height * factor));
    if (dstW !== width || dstH !== height) {
      data = resizeRgbaBilinear(data, width, height, dstW, dstH);
      width = dstW;
      height = dstH;
    }
  }

  if (format === 'jpeg') {
    const encoded = jpeg.encode({ data, width, height }, opts?.quality ?? 80);
    return { buffer: encoded.data, mimeType: 'image/jpeg', width, height };
  }

  const out = new PNG({ width, height });
  out.data = data;
  return { buffer: PNG.sync.write(out), mimeType: 'image/png', width, height };
}
