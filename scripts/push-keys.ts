// Prints a new VAPID key pair for the operator (ADR 0036). Nothing is written to a file and nothing is sent anywhere:
// copy the three lines into .env.local (local) or the GitHub Environment secrets (prod/preview), then clear the terminal.
// Never commit the output. VAPID_SUBJECT must be a contact as mailto: or https:// (Apple's push service requires it).
import { generateVapidKeys } from "../lib/push-crypto.ts";

const k = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log("VAPID_SUBJECT=mailto:deine@adresse.example   # durch eine echte Kontaktadresse ersetzen");
console.error("Neues Schlüsselpaar. Nicht committen; Terminal danach leeren. Public und Private gehören zusammen.");
