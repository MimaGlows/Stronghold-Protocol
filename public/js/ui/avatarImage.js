import { AVATAR_SIZE, AVATAR_MAX_BYTES, AVATAR_INPUT_MAX_BYTES, isAvatarChoice } from '../../../shared/avatar.js';
import { N_ } from '../../../shared/i18n.js';

/** Decode only user-selected raster files. No external URLs or SVG. */
export async function readAvatarImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(N_('请选择 PNG、JPEG 或 WebP 图片'));
  if (file.size > AVATAR_INPUT_MAX_BYTES) throw new Error(N_('图片不能超过 5 MB'));
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error(N_('图片已损坏或无法读取'))); image.src = url; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024) throw new Error(N_('图片尺寸过大，请先缩小图片'));
    return { image, url };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

/** The same source rectangle powers both preview and export. Offset is in preview pixels. */
export function cropRect(width, height, zoom = 1, x = 0, y = 0, previewSize = 256) {
  const scale = Math.max(previewSize / width, previewSize / height) * zoom;
  const maxX = (width * scale - previewSize) / 2, maxY = (height * scale - previewSize) / 2;
  const offsetX = Math.max(-maxX, Math.min(maxX, x)), offsetY = Math.max(-maxY, Math.min(maxY, y));
  return { sx: (width - previewSize / scale) / 2 - offsetX / scale, sy: (height - previewSize / scale) / 2 - offsetY / scale,
    size: previewSize / scale, x: offsetX, y: offsetY, scale };
}

export async function encodeAvatar(image, zoom, x, y) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(N_('浏览器无法处理图片'));
  const rect = cropRect(image.naturalWidth, image.naturalHeight, zoom, x, y);
  ctx.drawImage(image, rect.sx, rect.sy, rect.size, rect.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') throw new Error(N_('浏览器不支持 WebP 头像，请使用新版浏览器'));
    if (blob.size > AVATAR_MAX_BYTES) continue;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    const choice = { kind: 'custom', dataUrl };
    if (!isAvatarChoice(choice)) throw new Error(N_('头像压缩结果无效，请换一张图片'));
    return choice;
  }
  throw new Error(N_('图片无法压缩到头像大小限制，请换一张图片'));
}
