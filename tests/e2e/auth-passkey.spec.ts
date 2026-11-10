import { test, expect } from "@playwright/test";
import { createWebAuthnMock } from "../../packages/domain-auth/src/index";

test.describe("Auth Passkey Capabilities", () => {
  const mockConfig = {
    rpId: "meitheal.local",
    rpName: "Meitheal Auth",
    expectedOrigin: "https://meitheal.local"
  };
  
  const webAuthn = createWebAuthnMock(mockConfig);

  test("generates valid registration options", () => {
    const opts = webAuthn.generateRegistrationOptions("ryan");
    expect(opts.rp.name).toBe("Meitheal Auth");
    expect(opts.rp.id).toBe("meitheal.local");
    expect(opts.user.name).toBe("ryan");
    expect(opts.challenge).toBe("mock-challenge");
    expect(opts.pubKeyCredParams[0]?.alg).toBe(-7);
  });

  test("verifies registration responses", () => {
    const res = webAuthn.verifyRegistrationResponse({ id: "cred-123", rawId: "cred-123" });
    expect(res.verified).toBe(true);
    expect(res.credential.id).toBe("cred-123");
    expect(res.credential.publicKey).toBe("mock-pk");
  });

  test("generates and verifies authentication assertions", () => {
    const opts = webAuthn.generateAuthenticationOptions();
    expect(opts.challenge).toBe("mock-challenge");
    expect(opts.rpId).toBe("meitheal.local");

    const res = webAuthn.verifyAuthenticationResponse({ id: "login-123" });
    expect(res.verified).toBe(true);
    expect(res.expectedOrigin).toBe("https://meitheal.local");
    expect(res.credentialId).toBe("login-123");
  });
});

