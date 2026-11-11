// The commission plans and the commissioned sale of the demo (plan 2B.2 Task 30.4, Part G design PG §6), written by scripts/demo/sales.ts
// step 10. Free of imports but the demo accounts, so the e2e specs can read them.
import { LAURA, MARCELA } from "./accounts";

/**
 * The commission plans of the demo (Task 30.4): Laura sells as an employee of the company (her own party, a natural person with her RUT)
 * at 5 % and 7 % on «Café molido»; Marcela's sales go to an external agent (a supplier with its RUT and Cámara de Comercio) at 4 %.
 */
export const COMMISSION_PLANS = {
  employee: {
    name: "Laura Méndez · vendedora",
    payeeKind: "employee" as const,
    defaultRatePct: 5,
    paymentDays: 30,
    user: LAURA.email,
    party: { documentNumber: "52987614", firstName: "Laura", firstSurname: "Méndez", legalName: "Laura Méndez", email: "laura.mendez@cafedelnorte.example", phone: "3157654321" },
    category: { name: "Café molido", ratePct: 7 },
  },
  agent: {
    name: "Agencia Comercial del Caribe · agente",
    payeeKind: "agent" as const,
    defaultRatePct: 4,
    paymentDays: 45,
    user: MARCELA.email,
    party: { documentNumber: "901458236", legalName: "Agencia Comercial del Caribe S.A.S.", email: "cuentas@agenciacaribe.example", phone: "3015550142" },
  },
};

/**
 * The commissioned sale (Task 30.4): 20 × Café molido medio 250 g at $ 13.500 = $ 270.000 + IVA 5 % $ 13.500 = $ 283.500 to Catering
 * Corporativo Andes, sold by Laura; collected 40 % ($ 113.400) and then the rest ($ 170.100). At 7 % the commission is $ 18.900, accrued
 * $ 7.560 and $ 11.340 (each receipt's share of the invoice).
 */
export const COMMISSION_SALE = {
  notes: "Demostración: venta con comisión cobrada en dos recibos",
  party: "900667788",
  sku: "CAF-MOL-250",
  qty: 20,
  subtotal: 270_000,
  total: 283_500,
  receipts: [113_400, 170_100],
  commission: 18_900,
  commissions: [7_560, 11_340],
  reference: "TRF-CATERING-DEMO",
};

