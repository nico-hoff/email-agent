// Shared helpers for the browser tests. Only synthetic data (scripts/e2e-browser-serve.ts).
import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER_EMAIL } from "../scripts/e2e-browser-serve.ts";

export const AUTH_FILE = "test-results/.auth/user.json";

export async function signIn(page: Page, password: string = E2E_PASSWORD): Promise<void> {
  await page.goto("/welcome");
  await page.getByLabel("E-Mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

/**
 * The list is ready (hydrated and loaded) once the view buttons carry their counts: they come from the client-side fetch,
 * so clicks after this reach React handlers and not only the server-rendered HTML.
 */
export async function expectList(page: Page, timeout?: number): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Mails" })).toBeVisible({ timeout });
  await expect(page.getByRole("group", { name: "Ansicht" }).getByRole("button").first()).toHaveAccessibleName(/\d/, { timeout });
}
