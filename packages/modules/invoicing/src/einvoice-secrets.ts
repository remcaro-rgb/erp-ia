// The names of the secrets of electronic invoicing in the secret store (rule 12; migration 0099 accepts only these names): the signing
// certificate and its password (the country pack names them: `dian/<companyId>/certificate`, `dian/<companyId>/certificate-password`) and
// the PIN of the software registered with the DIAN. invoicing.software_pin.set writes the PIN; the e-invoice workflow reads it.

/** The secret holding the company's software PIN. */
export const softwarePinSecret = (companyId: string) => `dian/${companyId}/software-pin`;
