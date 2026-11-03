import { CdekError, type CdekInput } from './cdek.js';

function invalid(): never {
  throw new CdekError('CDEK_INVALID_INPUT', 400);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1000000)
    return invalid();
  return value;
}
function text(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return invalid();
  return value.trim();
}
function location(value: unknown): CdekInput['fromLocation'] {
  const data = object(value);
  const address = text(data.address, 300);
  return { code: positive(data.code), ...(address ? { address } : {}) };
}

/** Explicit measured parcels only; no fallback weights, dimensions or tariffs. */
export function parseCdekInput(body: unknown): CdekInput {
  const data = object(body);
  if (!Array.isArray(data.packages) || !data.packages.length || data.packages.length > 30)
    return invalid();
  const shipmentPoint = text(data.shipmentPoint, 255);
  const deliveryPoint = text(data.deliveryPoint, 255);
  return {
    tariffCode: positive(data.tariffCode),
    fromLocation: location(data.fromLocation),
    toLocation: location(data.toLocation),
    ...(shipmentPoint ? { shipmentPoint } : {}),
    ...(deliveryPoint ? { deliveryPoint } : {}),
    packages: data.packages.map((value) => {
      const p = object(value);
      return {
        weightG: positive(p.weightG),
        lengthCm: positive(p.lengthCm),
        widthCm: positive(p.widthCm),
        heightCm: positive(p.heightCm),
      };
    }),
  };
}
