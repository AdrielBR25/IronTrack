// Validação e limpeza de imagens enviadas para análise (Fase 03). Nada aqui grava em disco ou em banco: a imagem vive
// só na memória da requisição e é descartada no fim dela.
//
//  - Só JPEG e PNG (o app converte HEIC/HEIF/WebP para JPEG no aparelho). O tipo declarado precisa bater com os
//    primeiros bytes do arquivo (não confiamos na extensão nem no `data:` do cliente).
//  - Dimensões lidas do próprio arquivo (sem decodificar a imagem inteira): recusa imagens minúsculas ou enormes.
//  - Metadados removidos antes do envio à OpenAI: EXIF (inclui GPS e modelo do aparelho), XMP, IPTC e comentários
//    no JPEG; blocos de texto, data e EXIF no PNG. O conteúdo dos pixels não muda.
import { PHOTO_LIMITS, type PhotoMime } from '../../../../shared/nutrition/vision.ts';

export class ImageError extends Error {
  readonly code: 'photo_invalid' | 'photo_too_large' | 'photo_too_small';
  constructor(code: ImageError['code']) {
    super(code);
    this.code = code;
    this.name = 'ImageError';
  }
}

export interface CleanImage {
  mime: PhotoMime;
  bytes: Buffer;
  width: number;
  height: number;
}

const DATA_URL = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/;

export function sniffMime(b: Uint8Array): PhotoMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  return null;
}

/** Dimensões do JPEG (marcadores SOFn) ou do PNG (IHDR). null = arquivo malformado. */
export function imageSize(b: Buffer, mime: PhotoMime): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** JPEG sem APP1 (EXIF/XMP), APP3–APP13 (IPTC etc.), APP15 e comentários. Mantém APP0 (JFIF), APP2 (ICC) e APP14 (Adobe). */
export function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new ImageError('photo_invalid');
    const marker = b[i + 1];
    if (marker === 0xda) {
      out.push(b.subarray(i));
      return Buffer.concat(out);
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new ImageError('photo_invalid');
    const drop = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  throw new ImageError('photo_invalid');
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
/** PNG sem blocos de texto, EXIF e data. */
export function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) throw new ImageError('photo_invalid');
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new ImageError('photo_invalid');
}

/** data URL → imagem conferida e sem metadados. Lança ImageError com código fixo. */
export function readImageDataUrl(dataUrl: string): CleanImage {
  const m = DATA_URL.exec(dataUrl);
  if (!m) throw new ImageError('photo_invalid');
  const declared = m[1] as PhotoMime;
  if (Math.floor((m[2].length * 3) / 4) > PHOTO_LIMITS.maxBytes + 3) throw new ImageError('photo_too_large');
  const raw = Buffer.from(m[2], 'base64');
  if (raw.length > PHOTO_LIMITS.maxBytes) throw new ImageError('photo_too_large');
  if (raw.length < 64 || sniffMime(raw) !== declared) throw new ImageError('photo_invalid');
  const size = imageSize(raw, declared);
  if (!size || !size.width || !size.height) throw new ImageError('photo_invalid');
  if (Math.max(size.width, size.height) > PHOTO_LIMITS.maxSide) throw new ImageError('photo_too_large');
  if (Math.min(size.width, size.height) < PHOTO_LIMITS.minSide) throw new ImageError('photo_too_small');
  const bytes = declared === 'image/jpeg' ? stripJpeg(raw) : stripPng(raw);
  return { mime: declared, bytes, ...size };
}

export const toDataUrl = (img: CleanImage) => `data:${img.mime};base64,${img.bytes.toString('base64')}`;
