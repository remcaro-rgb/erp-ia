import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets the last Tailwind utility of a group win (the shadcn helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
