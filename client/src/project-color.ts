import { z } from "zod";

export const projectColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export type ProjectColor = z.infer<typeof projectColorSchema>;

export function projectColor(value: unknown): ProjectColor | null {
  const parsed = projectColorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
