// Preparação da foto no aparelho (Fase 03), antes de qualquer envio:
//  - lê JPEG, PNG, WebP, GIF estático e, quando o navegador sabe abrir, HEIC/HEIF (Safari/iPhone abre; a maioria dos
//    navegadores Android/desktop não: nesse caso a pessoa recebe uma orientação clara);
//  - aplica a orientação EXIF (foto "deitada" do celular) ao desenhar;
//  - reduz para no máximo PHOTO_LIMITS.targetSide no lado maior e recodifica em JPEG. A recodificação pelo canvas
//    descarta TODOS os metadados (EXIF, GPS, modelo do aparelho); o servidor ainda remove o que sobrar.
// Nada é guardado: a imagem fica só na memória da tela até a análise terminar ou a pessoa sair.
import { PHOTO_LIMITS } from '@shared/nutrition/vision.ts';

export class PhotoPrepError extends Error {
  readonly code: 'not_image' | 'heic_unsupported' | 'too_big' | 'too_small' | 'decode_failed';
  constructor(code: PhotoPrepError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'PhotoPrepError';
  }
}

export interface PreparedPhoto {
  /** data URL JPEG enviada ao servidor. */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/** Arquivo original aceito (antes de reduzir): fotos de celular podem passar de 10 MB. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const QUALITY_STEPS = [0.86, 0.78, 0.7, 0.6];
/** Alvo do arquivo final: bem abaixo do limite do servidor e rápido em 4G. */
export const TARGET_BYTES = 1_400_000;

export const isHeic = (f: Pick<File, 'type' | 'name'>) => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
export const isImageFile = (f: Pick<File, 'type' | 'name'>) => /^image\//i.test(f.type) || isHeic(f) || /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name);

/** Tamanho final mantendo a proporção, sem ampliar. */
export function fitSize(w: number, h: number, max: number = PHOTO_LIMITS.targetSide): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Bytes reais de uma data URL base64. */
export const dataUrlBytes = (u: string) => {
  const b64 = u.slice(u.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
};

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  // createImageBitmap com imageOrientation aplica a rotação EXIF; navegadores atuais já fazem isso também no <img>.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* cai para <img> (ex.: HEIC no Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode'));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('decode');
  }
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!isImageFile(file)) throw new PhotoPrepError('not_image', 'Escolha uma foto (JPEG, PNG, WebP ou HEIC).');
  if (file.size > MAX_INPUT_BYTES) throw new PhotoPrepError('too_big', 'Esta foto é grande demais. Tente outra ou tire uma nova.');
  let d;
  try {
    d = await decode(file);
  } catch {
    if (isHeic(file)) throw new PhotoPrepError('heic_unsupported', 'Este navegador não abre fotos HEIC. Tire a foto pelo botão da câmera ou, no iPhone, use Ajustes › Câmera › Formatos › "Mais Compatível".');
    throw new PhotoPrepError('decode_failed', 'Não consegui abrir esta imagem. Tente outra foto.');
  }
  try {
    if (Math.min(d.width, d.height) < PHOTO_LIMITS.minSide) throw new PhotoPrepError('too_small', 'A imagem é pequena demais para identificar os alimentos.');
    const { width, height } = fitSize(d.width, d.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoPrepError('decode_failed', 'Não consegui preparar a imagem neste aparelho.');
    // Fundo branco: PNG/WebP transparentes viram JPEG sem áreas pretas.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d.source, 0, 0, width, height);
    let dataUrl = '';
    for (const q of QUALITY_STEPS) {
      dataUrl = canvas.toDataURL('image/jpeg', q);
      if (dataUrlBytes(dataUrl) <= TARGET_BYTES) break;
    }
    if (!dataUrl.startsWith('data:image/jpeg')) throw new PhotoPrepError('decode_failed', 'Este navegador não conseguiu converter a imagem.');
    const bytes = dataUrlBytes(dataUrl);
    if (bytes > PHOTO_LIMITS.maxBytes) throw new PhotoPrepError('too_big', 'Esta foto é grande demais. Tente outra.');
    // A prévia usa a própria data URL (a CSP permite img-src data:; fetch de data: seria bloqueado por connect-src).
    return { dataUrl, width, height, bytes };
  } finally {
    d.close();
  }
}
