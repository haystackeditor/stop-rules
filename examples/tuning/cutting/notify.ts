import { readFileSync } from "node:fs";
import { sendEmail } from "./email.js";

export function subjectFor(kind: string): string {
  return kind === "welcome" ? "Welcome" : "Your update";
}

export function loadTemplate(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
  }
  return "";
}

export async function notify(address: string, kind: string): Promise<void> {
  const body = loadTemplate(`templates/${kind}.txt`);
  await sendEmail(address, subjectFor(kind), body);
}
