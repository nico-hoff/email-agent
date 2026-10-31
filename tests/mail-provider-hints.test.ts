import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultLabel, emailDomain, hostPlaceholder, imapHostForEmail, isGoogleHost } from "../lib/mail-provider-hints.ts";
import { detectSpamFolder } from "../lib/connection-test.ts";

describe("provider hints", () => {
  it("known domains map to their IMAP server", () => {
    const cases: [string, string][] = [
      ["a@gmail.com", "imap.gmail.com"], ["a@googlemail.com", "imap.gmail.com"], ["a@web.de", "imap.web.de"], ["a@gmx.de", "imap.gmx.net"], ["a@gmx.net", "imap.gmx.net"],
      ["a@outlook.com", "outlook.office365.com"], ["a@hotmail.com", "outlook.office365.com"], ["a@live.com", "outlook.office365.com"],
      ["a@icloud.com", "imap.mail.me.com"], ["a@me.com", "imap.mail.me.com"], ["a@t-online.de", "secureimap.t-online.de"],
      ["a@posteo.de", "posteo.de"], ["a@mailbox.org", "imap.mailbox.org"], ["  A@GMAIL.COM ", "imap.gmail.com"],
    ];
    for (const [mail, host] of cases) assert.equal(imapHostForEmail(mail), host, mail);
  });
  it("unknown or malformed addresses give null; the placeholder is imap.<domain>", () => {
    for (const m of ["", "a", "a@", "@x.de", "a@nodot", "a@exa mple.de", "a@firma.example"]) assert.equal(imapHostForEmail(m), null, m);
    assert.equal(hostPlaceholder("me@firma.example"), "imap.firma.example");
    assert.equal(hostPlaceholder("nonsense"), "imap.example.com");
    assert.equal(emailDomain("a@b@c.de"), "c.de");
  });
  it("google host check and default label", () => {
    assert.equal(isGoogleHost(" IMAP.gmail.com "), true);
    assert.equal(isGoogleHost("imap.web.de"), false);
    assert.equal(defaultLabel("  me@x.test "), "me@x.test");
    assert.equal(defaultLabel("y".repeat(80)).length, 40);
  });
});

describe("spam folder detection", () => {
  it("the special-use flag wins over names; then the known names in order; else null", () => {
    assert.equal(detectSpamFolder([{ path: "INBOX" }, { path: "Spam" }, { path: "Unerwünscht", specialUse: "\\Junk" }]), "Unerwünscht");
    assert.equal(detectSpamFolder([{ path: "INBOX" }, { path: "Spam" }, { path: "Junk" }]), "Junk");
    assert.equal(detectSpamFolder([{ path: "INBOX" }, { path: "Junk E-Mail" }]), "Junk E-Mail");
    assert.equal(detectSpamFolder([{ path: "INBOX" }, { path: "Archiv" }]), null);
  });
});
