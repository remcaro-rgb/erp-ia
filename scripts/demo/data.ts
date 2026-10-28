// The demo company's master data (Task 22): Café del Norte S.A.S. sells coffee, drinks and pastry to shops, restaurants
// and hotels, and buys green coffee, packaging and services. `pnpm db:seed` creates every record through its process
// (core.category.create, core.party.create, core.product.create) as Laura, so the audit, the outbox and the consecutive
// numbers are the real ones. Every party carries the full DIAN data (design §5.8a, rule 10): its `dian_status` is
// complete; it is not invoice-ready until its RUT (and Cámara de Comercio for a company) is attached, which the first
// recommendation points out. Fictitious companies and people, except where a well-known name helps the demo.

export interface DemoCategory {
  name: string;
  ivaRate: "19" | "5" | "0" | "EXC";
  incRate?: "2" | "4" | "8" | "16";
  defaultUom: string;
  incomeAccount?: string;
}

export const CATEGORIES: DemoCategory[] = [
  { name: "Café en grano", ivaRate: "5", defaultUom: "KGM", incomeAccount: "413505" },
  { name: "Café molido", ivaRate: "5", defaultUom: "KGM", incomeAccount: "413505" },
  // Food and drinks served on the premises pay the national consumption tax (INC 8 %) instead of IVA.
  { name: "Bebidas preparadas", ivaRate: "EXC", incRate: "8", defaultUom: "94", incomeAccount: "414005" },
  { name: "Repostería", ivaRate: "19", defaultUom: "94", incomeAccount: "414005" },
  { name: "Accesorios y empaques", ivaRate: "19", defaultUom: "NIU", incomeAccount: "413595" },
  { name: "Servicios", ivaRate: "19", defaultUom: "94", incomeAccount: "415595" },
];

/** The input of core.party.create (packages/modules/core/src/processes/party.ts). */
export interface DemoParty {
  kind: ("customer" | "supplier")[];
  personType: "1" | "2";
  documentType: "31" | "13";
  documentNumber: string;
  legalName?: string;
  firstName?: string;
  otherNames?: string;
  firstSurname?: string;
  secondSurname?: string;
  tradeName?: string;
  taxResponsibilities: string[];
  taxScheme: "01" | "04" | "ZA" | "ZZ";
  ciiu?: string;
  departmentCode: string;
  municipalityCode: string;
  addressLine: string;
  postalCode?: string;
  invoiceEmail?: string;
  supplierEmail?: string;
  phoneCc: string;
  phone: string;
  creditLimit?: number;
  contactName?: string;
}

const company = (
  kind: DemoParty["kind"],
  documentNumber: string,
  legalName: string,
  place: [department: string, municipality: string, address: string, postal?: string],
  extra: Partial<DemoParty> = {},
): DemoParty => {
  const slug = legalName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(s\.?a\.?s?\.?|ltda\.?|s\.a\.)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
  return {
    kind,
    personType: "1",
    documentType: "31",
    documentNumber,
    legalName,
    taxResponsibilities: ["O-15"],
    taxScheme: "01",
    departmentCode: place[0],
    municipalityCode: place[1],
    addressLine: place[2],
    ...(place[3] ? { postalCode: place[3] } : {}),
    ...(kind.includes("customer") ? { invoiceEmail: `facturacion@${slug}.co` } : {}),
    ...(kind.includes("supplier") ? { supplierEmail: `ventas@${slug}.co` } : {}),
    phoneCc: "57",
    phone: `60${documentNumber.slice(1, 9)}`,
    ...extra,
  };
};

const person = (
  kind: DemoParty["kind"],
  documentNumber: string,
  name: { firstName: string; otherNames?: string; firstSurname: string; secondSurname?: string },
  place: [department: string, municipality: string, address: string],
  email: string,
  phone: string,
  extra: Partial<DemoParty> = {},
): DemoParty => ({
  kind,
  personType: "2",
  documentType: "13",
  documentNumber,
  ...name,
  taxResponsibilities: ["R-99-PN"],
  taxScheme: "ZZ",
  departmentCode: place[0],
  municipalityCode: place[1],
  addressLine: place[2],
  ...(kind.includes("customer") ? { invoiceEmail: email } : {}),
  ...(kind.includes("supplier") ? { supplierEmail: email } : {}),
  phoneCc: "57",
  phone,
  ...extra,
});

const BOGOTA = ["11", "11001"] as const;
const MEDELLIN = ["05", "05001"] as const;
const CALI = ["76", "76001"] as const;

/** 40 parties: 28 customers, 10 suppliers and 2 that are both. */
export const PARTIES: DemoParty[] = [
  company(["customer"], "890903938", "Almacenes Éxito S.A.", ["05", "05266", "Carrera 48 # 32B Sur-139", "055422"], {
    tradeName: "Éxito",
    taxResponsibilities: ["O-13", "O-23"],
    ciiu: "4711",
    invoiceEmail: "recepcionfe@almacenes-exito.co",
    creditLimit: 250_000_000,
    contactName: "Paula Restrepo",
  }),
  company(["customer"], "900456781", "Supermercados La Colina S.A.S.", [...BOGOTA, "Calle 138 # 58-74", "111156"], { ciiu: "4711", creditLimit: 80_000_000 }),
  company(["customer"], "901234567", "Cafetería Los Almendros S.A.S.", [...MEDELLIN, "Carrera 70 # 44-12", "050031"], { ciiu: "5613", creditLimit: 12_000_000 }),
  company(["customer"], "900765432", "Restaurante Mar y Tierra S.A.S.", ["13", "13001", "Calle del Arsenal # 9A-45", "130001"], { ciiu: "5611", creditLimit: 18_000_000 }),
  company(["customer"], "860512347", "Hotel Cumbre Andina S.A.S.", [...BOGOTA, "Carrera 7 # 72-41", "110231"], { ciiu: "5511", taxResponsibilities: ["O-13"], creditLimit: 60_000_000 }),
  company(["customer"], "804012345", "Panadería San Gil Ltda.", ["68", "68001", "Calle 36 # 27-50", "680006"], { ciiu: "1081", creditLimit: 6_000_000 }),
  company(["customer"], "900888123", "Distribuidora Caribe Express S.A.S.", ["08", "08001", "Vía 40 # 73-290", "080001"], { ciiu: "4631", creditLimit: 45_000_000 }),
  company(["customer"], "901045678", "Tiendas Don Pacho S.A.S.", ["66", "66001", "Carrera 8 # 21-34", "660001"], { ciiu: "4711", taxResponsibilities: ["O-47"], creditLimit: 9_000_000 }),
  company(["customer"], "900321654", "Café Quindío Gourmet S.A.S.", ["63", "63001", "Carrera 14 # 12-07", "630004"], { ciiu: "5613", creditLimit: 15_000_000 }),
  company(["customer"], "890981234", "Club Campestre El Rodeo", [...MEDELLIN, "Carrera 76 # 1-50", "050026"], { ciiu: "9312", taxResponsibilities: ["O-13"], creditLimit: 30_000_000 }),
  company(["customer"], "900147258", "Casino y Eventos La Pradera S.A.S.", [...CALI, "Avenida 6N # 28N-10", "760045"], { ciiu: "5621", creditLimit: 20_000_000 }),
  company(["customer"], "901369258", "Oficinas Ejecutivas Torre 93 S.A.S.", [...BOGOTA, "Calle 93 # 11A-28", "110221"], { ciiu: "8211", creditLimit: 10_000_000 }),
  company(["customer"], "805001234", "Fundación Educativa Valle Alto", [...CALI, "Calle 5 # 66B-52", "760032"], { ciiu: "8544", taxResponsibilities: ["O-13"], creditLimit: 25_000_000 }),
  company(["customer"], "900654987", "Comercializadora Santander Café S.A.S.", ["68", "68001", "Carrera 33 # 48-21", "680003"], { ciiu: "4631", creditLimit: 35_000_000 }),
  company(["customer"], "901112223", "Mini Mercado La Esquina S.A.S.", ["17", "17001", "Carrera 23 # 64-15", "170004"], { ciiu: "4711", taxResponsibilities: ["O-47"], creditLimit: 4_000_000 }),
  company(["customer"], "900998877", "Restaurante El Fogón Paisa S.A.S.", [...MEDELLIN, "Calle 10 # 40-31", "050021"], { ciiu: "5611", creditLimit: 14_000_000 }),
  company(["customer"], "900445566", "Heladería Polar Andina S.A.S.", ["73", "73001", "Carrera 5 # 37-80", "730006"], { ciiu: "1052", creditLimit: 7_500_000 }),
  company(["customer"], "890112233", "Cadena Hotelera Sol del Caribe S.A.", ["13", "13001", "Avenida San Martín # 5-145", "130001"], { ciiu: "5511", taxResponsibilities: ["O-13", "O-23"], creditLimit: 90_000_000 }),
  company(["customer"], "901556677", "Coworking Nodo Centro S.A.S.", [...BOGOTA, "Carrera 13 # 26-45", "110311"], { ciiu: "6820", creditLimit: 5_000_000 }),
  company(["customer"], "900223344", "Pastelería Doña Inés S.A.S.", ["25", "25175", "Calle 12 # 9-31", "250001"], { ciiu: "1081", creditLimit: 6_500_000 }),
  company(["customer"], "901778899", "Droguería y Minimercado Soacha S.A.S.", ["25", "25754", "Autopista Sur # 30-15", "250051"], { ciiu: "4773", taxResponsibilities: ["O-47"], creditLimit: 3_500_000 }),
  company(["customer"], "900667788", "Catering Corporativo Andes S.A.S.", [...BOGOTA, "Avenida Calle 26 # 68C-61", "111071"], { ciiu: "5621", creditLimit: 40_000_000 }),
  company(["customer"], "900334455", "Restaurante Sabor Huilense S.A.S.", ["41", "41001", "Carrera 5 # 6-45", "410010"], { ciiu: "5611", creditLimit: 8_000_000 }),
  company(["customer"], "901889900", "Tienda de Café Cúcuta Norte S.A.S.", ["54", "54001", "Avenida 0 # 11-50", "540006"], { ciiu: "5613", creditLimit: 5_500_000 }),
  company(["customer"], "891408765", "Clínica Los Rosales S.A.", ["66", "66001", "Carrera 9 # 20-41", "660003"], { ciiu: "8610", taxResponsibilities: ["O-13"], creditLimit: 50_000_000 }),
  person(["customer"], "71654321", { firstName: "Andrés", otherNames: "Felipe", firstSurname: "Gómez", secondSurname: "Restrepo" }, [...MEDELLIN, "Calle 50 # 45-20 Apto 301"], "andres.gomez@correo.co", "3104567890", { creditLimit: 2_000_000 }),
  person(["customer"], "43123456", { firstName: "María", otherNames: "Fernanda", firstSurname: "Ospina", secondSurname: "Duque" }, ["05", "05266", "Carrera 43A # 38 Sur-15"], "mafe.ospina@correo.co", "3156789012", { creditLimit: 1_500_000 }),
  person(["customer"], "10234567", { firstName: "Carlos", otherNames: "Alberto", firstSurname: "Ruiz", secondSurname: "Zapata" }, ["66", "66001", "Calle 14 # 23-11"], "carlos.ruiz@correo.co", "3007654321", { creditLimit: 1_000_000 }),
  // Suppliers.
  company(["supplier"], "890801234", "Cooperativa de Caficultores del Norte", ["17", "17001", "Carrera 22 # 30-14", "170001"], { ciiu: "1061", taxResponsibilities: ["O-13", "O-23"], contactName: "Hernán Valencia" }),
  company(["supplier"], "900135791", "Trilladora La Montaña S.A.S.", ["63", "63001", "Kilómetro 3 vía Circasia", "630008"], { ciiu: "1061", contactName: "Luz Marina Arango" }),
  company(["supplier"], "900246802", "Tostadora Andina S.A.S.", [...BOGOTA, "Calle 17 # 68D-52", "110931"], { ciiu: "1062" }),
  company(["supplier"], "860024680", "Empaques Flexibles de Colombia S.A.S.", ["25", "25754", "Carrera 4 # 31-12 Zona Industrial", "250052"], { ciiu: "2221" }),
  company(["supplier"], "891300987", "Lácteos La Pradera S.A.", [...CALI, "Calle 70 # 1-35", "760002"], { ciiu: "1040", taxResponsibilities: ["O-13"] }),
  company(["supplier"], "900975310", "Transportes Rápido Cafetero S.A.S.", ["66", "66001", "Avenida 30 de Agosto # 87-298", "660004"], { ciiu: "4923" }),
  company(["supplier"], "890300456", "Azúcar del Valle S.A.", [...CALI, "Calle 15 # 26-101", "760022"], { ciiu: "1071", taxResponsibilities: ["O-13", "O-23"] }),
  company(["supplier"], "901357924", "Vasos y Desechables El Roble S.A.S.", [...MEDELLIN, "Carrera 52 # 14-30", "050024"], { ciiu: "1702" }),
  person(["supplier"], "4567890", { firstName: "Jorge", otherNames: "Eliécer", firstSurname: "Cárdenas", secondSurname: "Montoya" }, ["17", "17001", "Vereda La Cabaña, finca El Paraíso"], "finca.elparaiso@correo.co", "3128765432"),
  company(["supplier"], "900864213", "Mantenimiento Industrial Barista Pro S.A.S.", [...BOGOTA, "Calle 72 # 20-45", "111211"], { ciiu: "3312" }),
  // Customer and supplier.
  company(["customer", "supplier"], "900531642", "Café del Bosque S.A.S.", [...MEDELLIN, "Carrera 37 # 8A-32", "050021"], { ciiu: "1062", creditLimit: 22_000_000 }),
  company(["customer", "supplier"], "901642753", "Distribuciones Andinas del Café S.A.S.", [...BOGOTA, "Avenida Carrera 68 # 13-45", "111611"], { ciiu: "4631", creditLimit: 55_000_000 }),
];

/** The input of core.product.create, with the category and the main supplier named instead of their ids. */
export interface DemoProduct {
  sku: string;
  description: string;
  kind: "good" | "service";
  category: string;
  listPrice: number;
  standardCost?: number;
  uomCode?: string;
  idScheme?: "999" | "010";
  standardCode?: string;
  brand?: string;
  trackStock: boolean;
  minStock?: number;
  /** Document number of the main supplier. */
  supplier?: string;
}

const good = (sku: string, description: string, category: string, listPrice: number, standardCost: number, extra: Partial<DemoProduct> = {}): DemoProduct => ({
  sku,
  description,
  kind: "good",
  category,
  listPrice,
  standardCost,
  brand: "Café del Norte",
  trackStock: true,
  minStock: 10,
  ...extra,
});

/** 25 products: taxes and units come from their category unless the product says otherwise. */
export const PRODUCTS: DemoProduct[] = [
  good("CAF-GRA-KG", "Café en grano Norte Especial · kilo", "Café en grano", 62_000, 38_000, { supplier: "900135791", minStock: 20 }),
  good("CAF-GRA-500", "Café en grano Norte Especial 500 g", "Café en grano", 32_000, 19_500, { uomCode: "94", supplier: "900135791" }),
  good("CAF-GRA-250G", "Café en grano Geisha Sierra Nevada 250 g", "Café en grano", 48_000, 29_000, { uomCode: "94", supplier: "890801234" }),
  good("CAF-GRA-DEC", "Café en grano descafeinado 500 g", "Café en grano", 35_000, 22_000, { uomCode: "94", supplier: "900246802" }),
  good("CAF-GRA-ORG", "Café en grano orgánico Huila · kilo", "Café en grano", 74_000, 46_000, { supplier: "890801234" }),
  good("CAF-MOL-500", "Café molido tradicional 500 g", "Café molido", 24_000, 14_000, { uomCode: "94", supplier: "900246802" }),
  good("CAF-MOL-250", "Café molido medio 250 g", "Café molido", 13_500, 7_800, { uomCode: "94", supplier: "900246802" }),
  good("CAF-MOL-EXP", "Café molido para espresso · kilo", "Café molido", 58_000, 35_000, { supplier: "900135791" }),
  good("CAF-MOL-CAP", "Cápsulas de café compatibles x 10", "Café molido", 21_000, 11_000, { uomCode: "94" }),
  good("CAF-LIO-170", "Café liofilizado 170 g", "Café molido", 27_000, 15_500, { uomCode: "94", idScheme: "010", standardCode: "7709876543217" }),
  good("BEB-TIN-8", "Tinto 8 oz", "Bebidas preparadas", 2_500, 600, { trackStock: false, minStock: undefined }),
  good("BEB-CAP-12", "Capuchino 12 oz", "Bebidas preparadas", 7_500, 2_100, { trackStock: false, minStock: undefined }),
  good("BEB-LAT-12", "Latte 12 oz", "Bebidas preparadas", 7_800, 2_200, { trackStock: false, minStock: undefined }),
  good("BEB-AME-12", "Americano 12 oz", "Bebidas preparadas", 5_500, 1_200, { trackStock: false, minStock: undefined }),
  good("BEB-MOC-12", "Mocaccino 12 oz", "Bebidas preparadas", 8_900, 2_600, { trackStock: false, minStock: undefined }),
  good("BEB-FRA-16", "Frappé de café 16 oz", "Bebidas preparadas", 11_500, 3_400, { trackStock: false, minStock: undefined }),
  good("BEB-ARO", "Aromática de frutas", "Bebidas preparadas", 4_000, 900, { trackStock: false, minStock: undefined }),
  good("REP-CRO", "Croissant de mantequilla", "Repostería", 6_500, 2_300, { minStock: 15 }),
  good("REP-TOR-ZAN", "Torta de zanahoria · porción", "Repostería", 8_500, 3_100, { minStock: 8 }),
  good("REP-GAL-AVE", "Galletas de avena x 6", "Repostería", 9_000, 3_600, { minStock: 12 }),
  good("ACC-PRE-FRA", "Prensa francesa 1 litro", "Accesorios y empaques", 89_000, 52_000, { brand: "Barista Pro", minStock: 4 }),
  good("ACC-FIL-V60", "Filtros de papel V60 x 100", "Accesorios y empaques", 28_000, 16_000, { brand: "Barista Pro", minStock: 6 }),
  good("ACC-MUG-NOR", "Mug Café del Norte 12 oz", "Accesorios y empaques", 32_000, 14_000, { supplier: "901357924", minStock: 10 }),
  { sku: "SER-BAR-CUR", description: "Curso de barismo básico (8 horas)", kind: "service", category: "Servicios", listPrice: 450_000, trackStock: false },
  { sku: "SER-MAN-MAQ", description: "Mantenimiento preventivo de máquina espresso", kind: "service", category: "Servicios", listPrice: 280_000, standardCost: 150_000, trackStock: false, supplier: "900864213" },
];
