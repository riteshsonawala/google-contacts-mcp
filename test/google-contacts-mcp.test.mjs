import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  GoogleContactsClient,
  GoogleContactsBrowserClient,
  GoogleContactsMcpServer,
  parseContactsFromContent,
  loadImageData,
  extractContactViaVisionApi,
} from "../google-contacts-mcp.mjs";

// Minimal 1x1 PNG & 1x1 JPEG buffers for testing
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SAMPLE_JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe("Multi-format Contact Parser (Text & Markup)", () => {
  test("parses vCard (.vcf) into structured ContactInput", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Sonawala;Ritesh;;Mr.;",
      "FN:Ritesh Sonawala",
      "ORG:Acme Cloud;Platform Engineering",
      "TITLE:Principal Architect",
      "TEL;TYPE=CELL:+1-415-555-0199",
      "EMAIL;TYPE=WORK:ritesh@acmecloud.io",
      "ADR;TYPE=WORK:;;500 Howard St;San Francisco;CA;94105;USA",
      "URL:https://acmecloud.io",
      "BDAY:1990-05-15",
      "NOTE:Met at CloudNext conference",
      "END:VCARD",
    ].join("\r\n");

    const { format, contacts } = parseContactsFromContent(vcard);
    assert.equal(format, "vcard");
    assert.equal(contacts.length, 1);
    const c = contacts[0];
    assert.equal(c.givenName, "Ritesh");
    assert.equal(c.familyName, "Sonawala");
    assert.equal(c.fullName, "Ritesh Sonawala");
    assert.equal(c.organization, "Acme Cloud");
    assert.equal(c.department, "Platform Engineering");
    assert.equal(c.jobTitle, "Principal Architect");
    assert.equal(c.emails[0].value, "ritesh@acmecloud.io");
    assert.equal(c.phones[0].value, "+1-415-555-0199");
    assert.equal(c.addresses[0].city, "San Francisco");
    assert.equal(c.birthday, "1990-05-15");
    assert.equal(c.notes, "Met at CloudNext conference");
  });

  test("parses HTML email signature / h-card markup", () => {
    const html = `
      <div class="vcard">
        <p><strong class="p-name">Dr. Maya Lin</strong></p>
        <p><span class="p-job-title">VP of AI Research</span> at <span class="p-org">DeepNeural Labs</span></p>
        <p>Email: <a href="mailto:maya.lin@deepneural.ai">maya.lin@deepneural.ai</a></p>
        <p>Mobile: <a href="tel:+1-650-555-0142">+1 (650) 555-0142</a></p>
        <p>Web: <a href="https://deepneural.ai/maya">https://deepneural.ai/maya</a></p>
        <p>450 Serra Mall, Stanford, CA 94305</p>
      </div>
    `;

    const { format, contacts } = parseContactsFromContent(html);
    assert.equal(format, "html");
    const c = contacts[0];
    assert.equal(c.fullName, "Dr. Maya Lin");
    assert.equal(c.jobTitle, "VP of AI Research");
    assert.equal(c.organization, "DeepNeural Labs");
    assert.ok(c.emails.includes("maya.lin@deepneural.ai"));
    assert.ok(c.phones.some((p) => p.includes("650")));
    assert.ok(c.urls.includes("https://deepneural.ai/maya"));
  });

  test("parses Markdown bullet list & links", () => {
    const md = `
# Contact Card
- **Name**: Alex Rivera
- **Title**: Staff Engineer
- **Company**: Orbit Systems
- **Email**: [alex@orbitsystems.dev](mailto:alex@orbitsystems.dev)
- **Phone**: +1 (212) 555-0188
- **Website**: [Profile](https://orbitsystems.dev/alex)
- **Notes**: Discussed MCP integration
    `;

    const { format, contacts } = parseContactsFromContent(md);
    assert.equal(format, "markdown");
    const c = contacts[0];
    assert.equal(c.fullName, "Alex Rivera");
    assert.equal(c.jobTitle, "Staff Engineer");
    assert.equal(c.organization, "Orbit Systems");
    assert.ok(c.emails.includes("alex@orbitsystems.dev"));
    assert.ok(c.phones.includes("+1 (212) 555-0188"));
    assert.ok(c.urls.includes("https://orbitsystems.dev/alex"));
  });

  test("parses CSV contact rows", () => {
    const csv = [
      "First Name,Last Name,Email,Phone,Company,Title",
      "Liam,Patel,liam@novaventures.com,+1-408-555-0111,Nova Ventures,Partner",
      "Sofia,Chen,sofia@novaventures.com,+1-408-555-0122,Nova Ventures,Principal",
    ].join("\n");

    const { format, contacts } = parseContactsFromContent(csv);
    assert.equal(format, "csv");
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].givenName, "Liam");
    assert.equal(contacts[0].familyName, "Patel");
    assert.deepEqual(contacts[0].emails, ["liam@novaventures.com"]);
    assert.equal(contacts[1].givenName, "Sofia");
  });

  test("parses freeform email signature text", () => {
    const sig = `
Jordan Vance
Founder & CEO at HyperScale AI
jordan@hyperscale.ai
+1 (310) 555-0177
https://hyperscale.ai
100 Wilshire Blvd, Suite 400, Santa Monica, CA 90401
    `;

    const { format, contacts } = parseContactsFromContent(sig);
    assert.equal(format, "text");
    const c = contacts[0];
    assert.equal(c.fullName, "Jordan Vance");
    assert.equal(c.jobTitle, "Founder & CEO");
    assert.equal(c.organization, "HyperScale AI");
    assert.ok(c.emails.includes("jordan@hyperscale.ai"));
    assert.ok(c.phones.includes("+1 (310) 555-0177"));
    assert.ok(c.addresses.length >= 1);
  });
});

describe("Image (PNG / JPG) Loader & Vision Extraction", () => {
  test("loads PNG from data URI, raw base64, and file path, and detects JPG magic bytes", () => {
    const fromDataUri = loadImageData(`data:image/png;base64,${SAMPLE_PNG_BASE64}`);
    assert.equal(fromDataUri.mimeType, "image/png");
    assert.equal(fromDataUri.sourceType, "data-uri");

    const fromRaw = loadImageData(SAMPLE_PNG_BASE64);
    assert.equal(fromRaw.mimeType, "image/png");
    assert.equal(fromRaw.sourceType, "base64");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcontacts-mcp-"));
    const jpgPath = path.join(tmpDir, "card.jpg");
    fs.writeFileSync(jpgPath, SAMPLE_JPG_BYTES);

    const fromFile = loadImageData(jpgPath);
    assert.equal(fromFile.mimeType, "image/jpeg");
    assert.equal(fromFile.sourceType, "file");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts contact via Vision API when GEMINI_API_KEY is present", async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";

    try {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      fullName: "Elena Rostova",
                      jobTitle: "Chief Design Officer",
                      organization: "Studio K",
                      emails: [{ value: "elena@studiok.design", type: "work" }],
                      phones: [{ value: "+44 20 7946 0921", type: "mobile" }],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });

      const res = await extractContactViaVisionApi(
        SAMPLE_PNG_BASE64,
        "image/png",
        "Business card from London",
        mockFetch
      );
      assert.ok(res);
      assert.equal(res.contact.fullName, "Elena Rostova");
      assert.equal(res.contact.organization, "Studio K");
    } finally {
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });
});

describe("MCP Server & Google People API Integration (Mocked)", () => {
  function createMockServer() {
    const store = new Map();
    let idSeq = 1;

    const mockFetch = async (urlStr, options = {}) => {
      const url = new URL(urlStr);
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : undefined;

      // Search contacts
      if (url.pathname.endsWith("/people:searchContacts")) {
        const q = (url.searchParams.get("query") || "").toLowerCase();
        const matches = [];
        for (const person of store.values()) {
          const blob = JSON.stringify(person).toLowerCase();
          if (blob.includes(q)) {
            matches.push({ person });
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ results: matches }),
        };
      }

      // Create contact
      if (url.pathname.endsWith("/people:createContact") && method === "POST") {
        const resourceName = `people/c${idSeq++}`;
        const created = {
          ...body,
          resourceName,
          etag: `etag-${idSeq}`,
          names: body.names?.map((n) => ({
            ...n,
            displayName: [n.givenName, n.familyName].filter(Boolean).join(" "),
          })),
        };
        store.set(resourceName, created);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(created),
        };
      }

      // Update contact
      if (url.pathname.includes(":updateContact") && method === "PATCH") {
        const resName = url.pathname.replace(/^\/v1\//, "").replace(/:updateContact$/, "");
        const updated = {
          ...store.get(resName),
          ...body,
          resourceName: resName,
          etag: `etag-${++idSeq}`,
          names: body.names?.map((n) => ({
            ...n,
            displayName: [n.givenName, n.familyName].filter(Boolean).join(" "),
          })),
        };
        store.set(resName, updated);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(updated),
        };
      }

      // Get raw contact
      const matchPerson = url.pathname.match(/\/people\/c\d+$/);
      if (matchPerson && method === "GET") {
        const resName = matchPerson[0].slice(1);
        const person = store.get(resName);
        return {
          ok: Boolean(person),
          status: person ? 200 : 404,
          text: async () => JSON.stringify(person || { error: "Not found" }),
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      };
    };

    process.env.GOOGLE_ACCESS_TOKEN = "mock-access-token";
    const client = new GoogleContactsClient(mockFetch);
    const server = new GoogleContactsMcpServer(client);
    return { server, store };
  }

  test("handles initialize, tools/list, upsert_contact, and parse_and_upsert_contact", async () => {
    const { server } = createMockServer();

    // 1. initialize
    const initResp = await server.handleIncomingMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    assert.equal(initResp.result.serverInfo.name, "google-contacts-mcp");

    // 2. tools/list
    const toolsResp = await server.handleIncomingMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.ok(toolsResp.result.tools.length >= 9);

    // 3. upsert_contact (creates new contact)
    const createResp = await server.handleIncomingMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "upsert_contact",
        arguments: {
          fullName: "Samira Khan",
          emails: ["samira@khanlabs.io"],
          phones: ["+1-415-555-0100"],
          organization: "Khan Labs",
          jobTitle: "CTO",
        },
      },
    });
    const createdPayload = JSON.parse(createResp.result.content[0].text);
    assert.equal(createdPayload.action, "created");
    assert.equal(createdPayload.contact.displayName, "Samira Khan");

    // 4. upsert_contact again with same email + new phone (merges & updates existing contact!)
    const updateResp = await server.handleIncomingMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "upsert_contact",
        arguments: {
          emails: ["samira@khanlabs.io"],
          phones: ["+1-415-555-0999"],
          notes: "Updated from business card",
        },
      },
    });
    const updatedPayload = JSON.parse(updateResp.result.content[0].text);
    assert.equal(updatedPayload.action, "updated");
    assert.equal(updatedPayload.contact.phones.length, 2);

    // 5. extract_contact_from_image returns MCP image content block for harness vision when no Vision API key is set
    const imgResp = await server.handleIncomingMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "extract_contact_from_image",
        arguments: {
          imageSource: `data:image/png;base64,${SAMPLE_PNG_BASE64}`,
        },
      },
    });
    assert.equal(imgResp.result.content[0].type, "image");
    assert.equal(imgResp.result.content[0].mimeType, "image/png");
  });

  test("GoogleContactsBrowserClient automates contacts.google.com without any Client ID or Secret", async () => {
    let currentUrl = "https://contacts.google.com";
    const mockDriver = {
      goto: async (url) => {
        currentUrl = url;
      },
      url: async () => currentUrl,
      bringToFront: async () => {},
      close: async () => {},
      evaluate: async (fn, arg) => {
        const fnStr = fn.toString();
        // Login check
        if (fnStr.includes("ServiceLogin")) {
          return true;
        }
        // Count contact rows
        if (fnStr.includes("querySelectorAll('a[href*=\"/person/\"], [data-id]').length")) {
          return 1;
        }
        // Extract contacts from list DOM
        if (fnStr.includes("seen.has(resourceName)")) {
          return [
            {
              resourceName: "person/c999",
              displayName: "Priya Sharma",
              givenName: "Priya",
              familyName: "Sharma",
              emails: [{ value: "priya@sharma.dev", type: "work" }],
              phones: [{ value: "+1-415-555-0155", type: "mobile" }],
              organization: "Sharma Dev",
              jobTitle: "Founder",
              addresses: [],
              urls: [],
              customFields: [],
              groups: [],
            },
          ];
        }
        // Wait for form input
        if (fnStr.includes("First name")) {
          currentUrl = "https://contacts.google.com/person/c999";
          return true;
        }
        // Extract single contact from person DOM
        if (fnStr.includes("window.location.pathname.match")) {
          return {
            resourceName: "person/c999",
            displayName: "Priya Sharma",
            givenName: "Priya",
            familyName: "Sharma",
            emails: [{ value: "priya@sharma.dev", type: "work" }],
            phones: [
              { value: "+1-415-555-0155", type: "mobile" },
              { value: "+1-415-555-0199", type: "mobile" },
            ],
            organization: "Sharma Dev",
            jobTitle: "Founder",
            addresses: [],
            urls: [],
            customFields: [],
            groups: [],
          };
        }
        return undefined;
      },
    };

    const browserClient = new GoogleContactsBrowserClient({ driver: mockDriver });
    const mcpServer = new GoogleContactsMcpServer(browserClient);

    const upsertResp = await mcpServer.handleIncomingMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "upsert_contact",
        arguments: {
          fullName: "Priya Sharma",
          emails: ["priya@sharma.dev"],
          phones: ["+1-415-555-0199"],
        },
      },
    });

    const parsed = JSON.parse(upsertResp.result.content[0].text);
    assert.equal(parsed.action, "updated");
    assert.equal(parsed.contact.displayName, "Priya Sharma");
    assert.equal(parsed.contact.resourceName, "person/c999");
  });
});
