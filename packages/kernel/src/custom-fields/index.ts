// Dependency-free: also exported as `@erp/kernel/custom-fields` for the browser.
export { CUSTOM_FIELD_TYPES, CUSTOM_MISSING_PREFIX } from "./types";
export type { CustomFieldCaller, CustomFieldDef, CustomFieldsResult, CustomFieldType, ExtraData } from "./types";
export { isEmptyValue, validateCustomFields, validateCustomValue } from "./validate";
export { canView, roleIn, stripInvisible } from "./visibility";
