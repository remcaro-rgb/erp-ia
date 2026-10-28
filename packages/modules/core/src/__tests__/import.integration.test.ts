import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IMPORT_PROCESSES, importColumns, kernelModule, loadModules, registry, runProcess, setFileStore, type Caller, type RunProcessDeps } from "@erp/kernel";
import ExcelJS from "exceljs";
import { abandonImport, beginImport, buildTemplate, createBatch, MAX_XLSX_UNCOMPRESSED_BYTES, previewImport, runImport, submitImport, validateBatch } from "@erp/kernel/import";
import { deflatedZeros, forgedZip, MemoryFileStore } from "@erp/kernel/testing";
import { core } from "../index";
import { coreHarness, type CoreHarness } from "./helpers";

// Mass import into core entities (Task 13b), through the kernel's import processes and workflow. The workflow
// function `runImport` is called directly: without the workflow compiler its "use workflow" / "use step"
// directives are inert, so every step runs in order in this process against the real database, as the route's
// `start(runImport, …)` would run it. (The workflow runtime itself is exercised by the kernel's
// import-workflow.integration.test.ts under @workflow/vitest.)

/** The 24 columns of core.party.create (spec §5.8a plus kind, supplier e-mail, credit limit and contact), in order. */
const PARTY_COLUMNS = [
  "kind", "personType", "documentType", "documentNumber", "legalName", "firstSurname", "secondSurname", "firstName", "otherNames",
  "tradeName", "taxResponsibilities", "taxScheme", "ciiu", "countryCode", "departmentCode", "municipalityCode", "addressLine",
  "postalCode", "invoiceEmail", "supplierEmail", "phoneCc", "phone", "creditLimit", "contactName",
];

const HEADER = "kind;personType;documentType;documentNumber;legalName;taxResponsibilities;taxScheme;countryCode;departmentCode;municipalityCode;addressLine;invoiceEmail";
const partyLine = (documentNumber: string, legalName = `Cliente ${documentNumber} S.A.S.`) =>
  `customer;1;31;${documentNumber};${legalName};O-13;01;CO;11;11001;Cra 1 # 2-3;fe@cliente${documentNumber}.co`;
const csv = (...lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);

describe("mass import into core", () => {
  let h: CoreHarness;
  let deps: RunProcessDeps;
  const store = new MemoryFileStore();

  /** The seeded admin with a fresh step-up verification (kernel.import.run is sensitive by default). */
  const adminCaller = async (): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${h.seed.users.both}, ${h.companyId}, ${stepUpToken})`;
    return { ...h.admin, stepUpToken };
  };
  const importRow = async (importId: string) => (await h.sql`select * from kernel.imports where id = ${importId}`)[0]!;
  const errorsFile = async (attachmentId: string) => {
    const [a] = await h.sql<{ storage_path: string; file_name: string; tag: string }[]>`select storage_path, file_name, tag from kernel.attachments where id = ${attachmentId}`;
    expect(a).toMatchObject({ file_name: "errores.csv", tag: "Errores" });
    return new TextDecoder().decode(await store.get(a!.storage_path)).trimEnd().split("\r\n");
  };
  const partiesWith = async (documentNumber: string) =>
    (await h.sql<{ n: number }[]>`select count(*)::int as n from core.parties where company_id = ${h.companyId} and document_number = ${documentNumber}`)[0]!.n;
  const runFile = async (fileName: string, bytes: Uint8Array) => {
    const ids = await submitImport(deps, await adminCaller(), { entity: "core.party", fileName, bytes });
    return { ...ids, summary: await runImport({ ...ids, claims: h.admin.claims }) };
  };

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "clerk", companies: [0], role: "member" }] });
    // The workflow resolves entities and processes from the process-wide registry, as the app's workers do.
    if (!registry.hasModule(kernelModule.id)) loadModules(registry, [kernelModule, core]);
    deps = { sql: h.sql, registry };
    setFileStore(store);
    await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, IMPORT_PROCESSES.map((p) => p.id));
  });

  afterAll(async () => {
    setFileStore(undefined);
    await h.sql`delete from kernel.step_up_verifications where company_id = ${h.companyId}`;
    await h.cleanup();
  });

  it("template for parties has the 24 columns of spec §5.8a in order", async () => {
    expect(importColumns(registry, "core.party").map((c) => c.key)).toEqual(PARTY_COLUMNS);
    const template = await buildTemplate(registry, "core.party", "csv");
    expect(new TextDecoder().decode(template.bytes).trim().split(";")).toEqual(PARTY_COLUMNS);
    // The template process describes the same columns, as the caller.
    const described = await runProcess(deps, h.admin, "kernel.import.template", { entity: "core.party" });
    expect(described.columns.map((c: { key: string }) => c.key)).toEqual(PARTY_COLUMNS);
    // Categories are created through core.category.create (their declared create process).
    expect(importColumns(registry, "core.product_category").map((c) => c.key)).toEqual(["name", "ivaRate", "incRate", "otherTaxes", "defaultUom", "incomeAccount", "status"]);
  });

  it("a 4-row CSV with one bad NIT imports 3 rows, writes errores.csv with 1 line naming the NIT error, and audit shows \"3 creadas · 1 rechazada\"", async () => {
    const file = csv(HEADER, partyLine("900373115"), partyLine("800197268"), partyLine("860002964"), partyLine("800ABC123", "Mal Dato Ltda."));

    // The preview validates every row in a dry run and writes nothing.
    const preview = await previewImport(deps, h.admin, { entity: "core.party", fileName: "terceros.csv", bytes: file });
    expect(preview).toMatchObject({ total: 4, missingColumns: [], unknownHeaders: [] });
    expect(preview.rows.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(preview.rows[3]!.errors.join(" ")).toContain("31: solo dígitos");
    expect(await partiesWith("900373115")).toBe(0);

    const { importId, chainId, summary } = await runFile("terceros.csv", file);
    expect(summary).toMatchObject({ status: "done", total: 4, created: 3, rejected: 1, summary: "3 creadas · 1 rechazada" });
    for (const nit of ["900373115", "800197268", "860002964"]) expect(await partiesWith(nit)).toBe(1);

    const row = await importRow(importId);
    expect(row).toMatchObject({ entity: "core.party", status: "done", rows_total: 4, rows_ok: 3, rows_failed: 1, started_by: h.seed.users.both, error: null });
    expect(row.finished_at).not.toBeNull();
    expect(row.file_attachment_id).not.toBeNull();
    const [source] = await h.sql`select file_name, tag from kernel.attachments where id = ${row.file_attachment_id}`;
    expect(source).toMatchObject({ file_name: "terceros.csv", tag: "Archivo original" });

    const lines = await errorsFile(row.errors_attachment_id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`fila;error;${HEADER}`);
    expect(lines[1]).toMatch(/^5;/);
    expect(lines[1]).toContain("31: solo dígitos");
    expect(lines[1]).toContain("800ABC123");

    // One chain: the import, its rows (origin api) and the summary entry on the import record.
    const audit = await h.sql<{ process_id: string; action: string; origin: string; entity: string; row_id: string | null; input: Record<string, unknown> }[]>`
      select process_id, action, origin, entity, row_id, input from kernel.audit_log where chain_id = ${chainId} and process_id is not null and origin <> 'db'
      order by occurred_at`;
    // Process-level entries (the row triggers add their own, on the table).
    const creates = audit.filter((a) => a.process_id === "core.party.create" && a.entity === "core.party");
    expect(creates).toHaveLength(3);
    expect(creates.every((a) => a.origin === "api" && a.action === "insert")).toBe(true);
    const final = audit.filter((a) => a.process_id === "kernel.import.run" && a.action === "update" && a.entity === "kernel.import").at(-1);
    expect(final).toMatchObject({ origin: "api", row_id: importId, input: { summary: "3 creadas · 1 rechazada", created: 3, rejected: 1 } });
    // kernel.import.run itself is audited as the user's insert of the import record.
    expect(audit.find((a) => a.process_id === "kernel.import.run" && a.action === "insert")).toMatchObject({ origin: "ui", row_id: importId });
    // The history lists it with its file name.
    const history = await runProcess(deps, h.admin, "kernel.import.list", { entity: "core.party" });
    expect(history[0]).toMatchObject({ id: importId, fileName: "terceros.csv", status: "done", rowsOk: 3, rowsFailed: 1 });
  });

  it("duplicate document in the file and in the table are both rejected", async () => {
    await runProcess(deps, h.admin, "core.party.create", {
      kind: ["customer"], personType: "1", documentType: "31", documentNumber: "901000001", legalName: "Ya Existe S.A.S.",
      taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1", invoiceEmail: "fe@ya.co",
    });
    const file = csv(HEADER, partyLine("901000001"), partyLine("901000002"), partyLine("901000002", "Repetido S.A.S."), partyLine("901000003"));
    const { importId, summary } = await runFile("repetidos.csv", file);
    expect(summary).toMatchObject({ created: 2, rejected: 2, summary: "2 creadas · 2 rechazadas" });
    expect(await partiesWith("901000001")).toBe(1);
    expect(await partiesWith("901000002")).toBe(1);
    expect(await partiesWith("901000003")).toBe(1);
    const [, inTable, inFile] = await errorsFile((await importRow(importId)).errors_attachment_id);
    expect(inTable).toMatch(/^2;Ya existe un tercero con documento 31 901000001;/);
    // The second occurrence in the file is refused before any creation, naming the row it repeats.
    expect(inFile).toMatch(/^4;documentType, documentNumber: repetido en el archivo \(igual a la fila 3\);/);
    expect(inFile).toContain("Repetido S.A.S.");
  });

  it("the preview refuses an in-file duplicate document like the run does", async () => {
    const file = csv(HEADER, partyLine("903000001"), partyLine("903000001", "Otra Vez S.A.S."));
    const preview = await previewImport(deps, h.admin, { entity: "core.party", fileName: "dup.csv", bytes: file });
    expect(preview.rows.map((r) => r.ok)).toEqual([true, false]);
    expect(preview.rows[1]!.errors).toEqual(["documentType, documentNumber: repetido en el archivo (igual a la fila 2)"]);
  });

  it("a header missing a required column refuses every row with the reason and creates nothing", async () => {
    const header = HEADER.replace("documentNumber;", "");
    const line = (name: string) => partyLine("x", name).replace(";x;", ";");
    const { importId, summary } = await runFile("sin-documento.csv", csv(header, line("Sin Documento Uno"), line("Sin Documento Dos")));
    expect(summary).toMatchObject({ status: "done", created: 0, rejected: 2 });
    const lines = await errorsFile((await importRow(importId)).errors_attachment_id);
    expect(lines.slice(1).every((l) => l.includes("documentNumber: obligatorio"))).toBe(true);
    expect((await h.sql`select 1 from core.parties where company_id = ${h.companyId} and legal_name like 'Sin Documento%'`).length).toBe(0);
  });

  it("a reference column takes the target's name: products import into the category the caller sees", async () => {
    await runProcess(deps, h.admin, "core.category.create", { name: "Café", ivaRate: "5", otherTaxes: [], defaultUom: "KGM", status: "active" });
    const file = csv("sku;description;kind;categoryId;listPrice;trackStock", "IMP-1;Café molido;good;café;31.000;sí", "IMP-2;Té verde;good;Té;9000;no");
    const ids = await submitImport(deps, await adminCaller(), { entity: "core.product", fileName: "productos.csv", bytes: file });
    const summary = await runImport({ ...ids, claims: h.admin.claims });
    expect(summary).toMatchObject({ created: 1, rejected: 1 });
    const [product] = await h.sql`select p.list_price, c.name as category from core.products p join core.product_categories c on c.id = p.category_id where p.company_id = ${h.companyId} and p.sku = 'IMP-1'`;
    expect(product).toMatchObject({ category: "Café" });
    expect(Number(product!.list_price)).toBe(31000);
    const [, refused] = await errorsFile((await importRow(ids.importId)).errors_attachment_id);
    expect(refused).toContain("categoryId: «Té» no existe");
  });

  it("import by a role without kernel.import.run is forbidden", async () => {
    const clerkId = h.seed.users.clerk!;
    const clerk: Caller = { claims: h.seed.claimsFor(clerkId, h.companyId), origin: "ui" };
    // The clerk may create parties one by one, not import them.
    await h.grantAll(h.companyId, h.seed.companies[0]!.memberRoleId, ["core.party.create", "kernel.attachment.add", "kernel.import.template", "kernel.import.preview"]);
    const chainId = randomUUID();
    await expect(
      submitImport(deps, { ...clerk, chainId }, { entity: "core.party", fileName: "terceros.csv", bytes: csv(HEADER, partyLine("902000001")) }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await h.sql`select 1 from kernel.imports where company_id = ${h.companyId} and started_by = ${clerkId}`).length).toBe(0);
    const [denied] = await h.sql`select action, process_id from kernel.audit_log where chain_id = ${chainId}`;
    expect(denied).toMatchObject({ action: "denied", process_id: "kernel.import.run" });
    expect(await partiesWith("902000001")).toBe(0);
  });

  describe("visibility, counts and refusals (review round 1)", () => {
    /** A user of company 0 holding only `roleId` (a role made for the test, so grants do not leak to other members). */
    const userWithRole = async (name: string, processes: string[], partyScope = "ambos") => {
      const [role] = await h.sql<{ id: string }[]>`
        insert into kernel.roles(company_id, name, is_system, party_scope) values (${h.companyId}, ${name}, false, ${partyScope}) returning id`;
      await h.grantAll(h.companyId, role!.id, processes);
      const userId = h.seed.users.clerk!;
      await h.seed.holdRoles(userId, h.companyId, [role!.id]);
      return { ...h.seed.claimsFor(userId, h.companyId), role_ids: [role!.id] };
    };
    const IMPORTER = ["core.party.create", "kernel.attachment.add", "kernel.attachment.list", ...IMPORT_PROCESSES.map((p) => p.id)];
    const stepUp = async (userId: string) => {
      const token = randomUUID();
      await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${userId}, ${h.companyId}, ${token})`;
      return token;
    };

    it("an import and its files are visible only to the user who started it and to company admins", async () => {
      // The clerk imports under an "importador" role (made for the test, so the grant does not reach other members).
      const importer = await userWithRole("importador", IMPORTER);
      const ids = await submitImport(deps, { claims: importer, origin: "ui", stepUpToken: await stepUp(importer.sub) }, { entity: "core.party", fileName: "mios.csv", bytes: csv(HEADER, partyLine("904000001")) });
      await runImport({ ...ids, claims: importer });
      const own = await runProcess(deps, { claims: importer, origin: "ui" }, "kernel.import.list", {});
      expect(own.map((i: { id: string }) => i.id)).toContain(ids.importId);
      const ownFiles = await runProcess(deps, { claims: importer, origin: "ui" }, "kernel.attachment.list", { entity: "kernel.import", recordId: ids.importId });
      expect(ownFiles.map((f: { fileName: string; mimeType: string }) => [f.fileName, f.mimeType])).toEqual([["mios.csv", "text/csv"]]);

      // Another member of the company (user `onlyA` under a reader role) sees nothing of it.
      const [readerRole] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, 'lector', false) returning id`;
      await h.grantAll(h.companyId, readerRole!.id, ["kernel.attachment.list", "kernel.attachment.remove", "kernel.import.list"]);
      await h.seed.holdRoles(h.seed.users.onlyA, h.companyId, [readerRole!.id]);
      const other = { ...h.seed.claimsFor(h.seed.users.onlyA, h.companyId), role_ids: [readerRole!.id] };
      const otherCaller = { claims: other, origin: "ui" as const };
      expect((await runProcess(deps, otherCaller, "kernel.import.list", {})).map((i: { id: string }) => i.id)).not.toContain(ids.importId);
      await expect(runProcess(deps, otherCaller, "kernel.attachment.list", { entity: "kernel.import", recordId: ids.importId })).rejects.toMatchObject({ code: "not_found" });
      const [source] = await h.sql<{ id: string }[]>`select id from kernel.attachments where entity = 'kernel.import' and record_id = ${ids.importId}`;
      // The signed download (GET /api/attachments?id=) is granted only through kernel.attachment.list: refused above.
      await expect(runProcess(deps, otherCaller, "kernel.attachment.remove", { id: source!.id })).rejects.toMatchObject({ code: "forbidden" });
      // A reader who may run kernel.import.run (so attaching files to imports is allowed in general) still cannot
      // remove a file of an import they neither started nor administer: the record is not visible to them.
      const [importerRole] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, 'lector_importador', false) returning id`;
      await h.grantAll(h.companyId, importerRole!.id, ["kernel.attachment.remove", "kernel.import.run"]);
      await h.seed.holdRoles(h.seed.users.onlyA, h.companyId, [importerRole!.id]);
      const otherImporter = { claims: { ...other, role_ids: [importerRole!.id] }, origin: "ui" as const };
      await expect(runProcess(deps, otherImporter, "kernel.attachment.remove", { id: source!.id })).rejects.toMatchObject({ code: "not_found" });
      expect((await h.sql`select removed_at from kernel.attachments where id = ${source!.id}`)[0]!.removed_at).toBeNull();
      const viaView = await h.sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...other })}, true)`;
        await tx`set local role authenticated`;
        return tx`select id from kernel.imports where id = ${ids.importId} union all select id from kernel.v_imports where id = ${ids.importId}`;
      });
      expect(viaView).toHaveLength(0);

      // The company admin sees it and its files.
      expect((await runProcess(deps, h.admin, "kernel.import.list", {})).map((i: { id: string }) => i.id)).toContain(ids.importId);
      expect(await runProcess(deps, h.admin, "kernel.attachment.list", { entity: "kernel.import", recordId: ids.importId })).toHaveLength(1);
    });

    it("a caller with kernel.import.run but not the entity's create process is refused", async () => {
      const claims = await userWithRole("solo_importa", ["kernel.attachment.add", ...IMPORT_PROCESSES.map((p) => p.id)]);
      await expect(
        submitImport(deps, { claims, origin: "ui", stepUpToken: await stepUp(claims.sub) }, { entity: "core.party", fileName: "x.csv", bytes: csv(HEADER, partyLine("905000001")) }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(previewImport(deps, { claims, origin: "ui" }, { entity: "core.party", fileName: "x.csv", bytes: csv(HEADER, partyLine("905000001")) })).rejects.toMatchObject({ code: "forbidden" });
      expect(await partiesWith("905000001")).toBe(0);
    });

    it("a retried creation batch replays its rows instead of duplicating them, and an abandon keeps the counts", async () => {
      const ids = await submitImport(deps, await adminCaller(), { entity: "core.party", fileName: "lote.csv", bytes: csv(HEADER, partyLine("906000001"), partyLine("906000002"), partyLine("906ABC")) });
      const args = { ...ids, claims: h.admin.claims };
      expect(await beginImport(args)).toEqual({ ok: true, total: 3 });
      const validated = await validateBatch(args, 0, 0);
      expect(validated.valid).toEqual([0, 1]);
      expect((await importRow(ids.importId)).rows_failed).toBe(1);
      const first = await createBatch(args, validated.valid, { created: 0, failed: 1 });
      // The step runs again (a retry after a crash): the rows replay their stored results.
      const again = await createBatch(args, validated.valid, { created: 0, failed: 1 });
      expect(first).toEqual({ created: 2, failed: [] });
      expect(again).toEqual({ created: 2, failed: [] });
      expect(await partiesWith("906000001")).toBe(1);
      expect(await partiesWith("906000002")).toBe(1);
      expect(await importRow(ids.importId)).toMatchObject({ rows_ok: 2, rows_failed: 1, status: "running" });

      // The workflow gives up before finishing: the import fails with the counts it reached.
      const abandoned = await abandonImport(args, "Se perdió la conexión");
      expect(abandoned).toMatchObject({ status: "failed", total: 3, created: 2, rejected: 1 });
      expect(await importRow(ids.importId)).toMatchObject({ status: "failed", rows_ok: 2, rows_failed: 1, error: "Se perdió la conexión" });
    });

    it("rows whose create process needs a step-up stop the import at the first one, with one denial", async () => {
      await h.sql`insert into kernel.sensitive_processes(company_id, process_id, mode) values (${h.companyId}, 'core.party.create', 'self_2fa')`;
      try {
        const file = csv(HEADER, partyLine("907000001"), partyLine("907000002"));
        await expect(previewImport(deps, h.admin, { entity: "core.party", fileName: "s.csv", bytes: file })).rejects.toMatchObject({ code: "invalid_input" });
        const { importId, chainId, summary } = await runFile("sensibles.csv", file);
        expect(summary).toMatchObject({ status: "failed", created: 0, summary: "row_step_up_required" });
        expect(await importRow(importId)).toMatchObject({ status: "failed", error: "row_step_up_required" });
        const denials = await h.sql`select 1 from kernel.audit_log where chain_id = ${chainId} and action = 'denied' and process_id = 'core.party.create'`;
        expect(denials).toHaveLength(1);
        expect(await partiesWith("907000001")).toBe(0);
      } finally {
        await h.sql`delete from kernel.sensitive_processes where company_id = ${h.companyId}`;
      }
    });

    it("an unreadable or oversized file is refused before it is stored, and a wide workbook is refused in the preview", async () => {
      const refused = await submitImport(deps, await adminCaller(), { entity: "core.party", fileName: "roto.xlsx", bytes: new TextEncoder().encode("no es un zip") }).catch((e: unknown) => e);
      expect(refused).toMatchObject({ code: "invalid_input", details: ["El archivo no es un libro de Excel (.xlsx) válido"] });
      const [row] = await h.sql`select id, status from kernel.imports i where company_id = ${h.companyId} and status = 'failed' and error = 'El archivo no es un libro de Excel (.xlsx) válido'`;
      expect(row).toBeDefined();
      expect(await h.sql`select 1 from kernel.attachments where entity = 'kernel.import' and record_id = ${row!.id}`).toHaveLength(0);

      const book = new ExcelJS.Workbook();
      book.addWorksheet("Datos").getCell(1, 300).value = "x";
      const wide = new Uint8Array(await book.xlsx.writeBuffer());
      await expect(previewImport(deps, h.admin, { entity: "core.party", fileName: "ancho.xlsx", bytes: wide })).rejects.toMatchObject({
        code: "invalid_input",
        details: ["El archivo tiene más de 256 columnas"],
      });
    });

    it("a party outside the role's scope refuses that row only, in the preview and the run (review round 2)", async () => {
      const claims = await userWithRole("solo_clientes", IMPORTER, "clientes");
      const supplierRow = partyLine("909000003", "Proveedor Fuera S.A.S.").replace(/^customer;/, "supplier;");
      const file = csv(HEADER, partyLine("909000001"), supplierRow, partyLine("909000002"));
      const preview = await previewImport(deps, { claims, origin: "ui" }, { entity: "core.party", fileName: "alcance.csv", bytes: file });
      expect(preview.rows.map((r) => r.ok)).toEqual([true, false, true]);
      expect(preview.rows[1]!.errors).toEqual(["El alcance de tu rol no cubre terceros de tipo proveedor"]);
      const ids = await submitImport(deps, { claims, origin: "ui", stepUpToken: await stepUp(claims.sub) }, { entity: "core.party", fileName: "alcance.csv", bytes: file });
      const summary = await runImport({ ...ids, claims });
      expect(summary).toMatchObject({ status: "done", created: 2, rejected: 1 });
      expect(await partiesWith("909000001")).toBe(1);
      expect(await partiesWith("909000003")).toBe(0);
      const [, refused] = await errorsFile((await importRow(ids.importId)).errors_attachment_id);
      expect(refused).toMatch(/^3;El alcance de tu rol no cubre terceros de tipo proveedor;/);
    });

    it("a corrected copy of a refused row is not an in-file duplicate", async () => {
      const bad = partyLine("910000001", "Correo Malo S.A.S.").replace("fe@empresa.co", "correo-malo").replace(/fe@cliente\d+\.co$/, "correo-malo");
      const file = csv(HEADER, bad, partyLine("910000001", "Correo Bueno S.A.S."));
      const preview = await previewImport(deps, h.admin, { entity: "core.party", fileName: "corregido.csv", bytes: file });
      expect(preview.rows.map((r) => r.ok)).toEqual([false, true]);
      expect(preview.rows[0]!.errors.join(" ")).toContain("Correo de facturas");
      const { summary } = await runFile("corregido.csv", file);
      expect(summary).toMatchObject({ created: 1, rejected: 1 });
      expect(await partiesWith("910000001")).toBe(1);
    });

    it("a workbook part that lies about its size is refused as invalid_input without being inflated whole", async () => {
      const bomb = forgedZip({ data: await deflatedZeros(2 * MAX_XLSX_UNCOMPRESSED_BYTES), method: 8, declaredSize: 1024 });
      await expect(previewImport(deps, h.admin, { entity: "core.party", fileName: "bomba.xlsx", bytes: bomb })).rejects.toMatchObject({
        code: "invalid_input",
        details: ["El libro de Excel es demasiado grande al descomprimirlo"],
      });
      await expect(submitImport(deps, await adminCaller(), { entity: "core.party", fileName: "bomba.xlsx", bytes: bomb })).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
