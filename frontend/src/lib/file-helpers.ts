export function isImageURL(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|$)/i.test(name);
}

export function isImageContentType(ct: string): boolean {
  return /^image\//i.test(ct);
}
