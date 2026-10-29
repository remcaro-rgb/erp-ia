import "./zod-locale";

export const KERNEL_VERSION = "0.1.0";
export { writeAudit, setAuditContext } from "./audit/audit";
export { AUDIT_ACTIONS, AUDIT_FEATURE, AUDIT_ORIGINS, AUDIT_PROCESSES, auditConsult, auditEntity } from "./audit/viewer";
export type { AuditAction, AuditContext, AuditEntry, Origin } from "./audit/audit";
export { USER_PROCESSES, USERS_FEATURE, userConsult, userEntity } from "./users/entity";
export { membershipInactive } from "./users/membership";
export { auditEntityOf, auditEntryDetail, auditEntryRead, describeAuditEntry, readAuditEntry } from "./audit/detail";
export type { AuditEntryDetail, AuditEntrySummary, AuditFieldChange, AuditInputValue, AuditRecord } from "./audit/detail";
export { countryPackOf, fieldOfKey, valueText } from "./registry/labels";
export type { LabelledField, Translate, ValueLabels } from "./registry/labels";
export { recordTitles } from "./records/titles";
export type { RecordRef } from "./records/titles";
export { cloneDraft, draftValues } from "./records/clone";
export { enqueueEvent } from "./events/outbox";
export type { OutboxEvent } from "./events/outbox";
export { consumers, ConsumerRegistry, SYSTEM_USER_ID } from "./events/consumers";
export { drainOutbox } from "./events/drain";
export type { DrainOptions } from "./events/drain";
export { dispatchOutboxRow } from "./events/dispatch.workflow";
export type { JwtClaims, Tx } from "./db/client";
export { withClaims } from "./db/client";
export { getServiceDb } from "./db/service";
export { defineEntity, hasRecordPage, recordHref, recordPageEntities, Registry, registry, USER_ENTITY } from "./registry";
export type { ConsumerContext, EntityDef, EventConsumer, FeatureDef, FieldDef, FieldType, HomeKpiProvider, Kpi, ModuleDef, NavItem, ProcessDef, ProcessKind, ResolvedEntityDef, ResolvedFieldDef } from "./registry";
export { maskedViewSql } from "./security/masked-views";
export { defineProcess } from "./process/define";
export { runProcess } from "./process/run";
export type { RunProcessDeps, RunProcessOptions } from "./process/run";
export { isMembershipInactive, MEMBERSHIP_INACTIVE, ProcessError } from "./process/errors";
export type { ProcessErrorCode, ProcessErrorStage } from "./process/errors";
export type { Caller, ProcessContext } from "./process/context";
export { defineModule } from "./module/define";
export { loadModules } from "./module/loader";
export { entitled, entitlementLimit, enableModule, syncModuleManifest } from "./entitlements/resolver";
export type { EntitledFn } from "./entitlements/resolver";
export { CODE_TABLES, registerCountryPack, countryPack } from "./localization/country-pack";
export { DEFAULT_PHONE_CC, validateEmail, validatePhone } from "./validation";
export type { CodeTable, CountryPack, DocumentType, PartyFiscalInput, PartyValidation, ProductFiscalInput, ProductValidation, TaxIdResult } from "./localization/country-pack";
export { kernelModule } from "./module/kernel-module";
export { ATTACHMENT_PROCESSES, attachmentAdd, attachmentList, attachmentRemove, attachmentReorder, MAX_ATTACHMENT_BYTES, missingAttachments, precheckAttachment, requiredTagsFor, requirementApplies } from "./attachments";
export type { ConditionFacts, RecordFacts, RequiredTag } from "./attachments";
export { AI_PROCESSES, imageSuggest, PHOTO_AI_TAG } from "./ai/image-suggest";
export { initialsOf, placeholderImage } from "./ai/placeholder";
export { CUSTOM_MISSING_PREFIX, stripInvisible, validateCustomFields, validateCustomValue } from "./custom-fields";
export type { CustomFieldCaller, CustomFieldDef, CustomFieldsResult, CustomFieldType, ExtraData } from "./custom-fields";
export { CUSTOM_FIELD_PROCESSES, customData, customFieldList, customFieldRemove, customFieldSet, extraFree, loadCustomFields, visibleExtra } from "./custom-fields/server";
export type { CustomData, CustomFieldRow, CustomFieldView } from "./custom-fields/server";
export { normalizeVerifyValue, registeredVerifiers, registerVerifier, unregisterVerifier, verify, verifierAdapter, VERIFY_PROCESSES, verifyRequest, verifyStatus } from "./verify";
export type { VerifierAdapter, VerifyContext, VerifyKind, VerifyOutcome, VerifyStatus } from "./verify";
export { callerProfile, MAX_USER_PREF_BYTES, readUserPrefs, USER_PREF_KEY, USER_PREF_PROCESSES, userPrefSet } from "./user-prefs";
export type { CallerProfile, StoredUserPref } from "./user-prefs";
export { runnableProcesses } from "./process/permissions";
export { buildQuery, GridState, operatorsFor, QueryError, refLabelKey } from "./query";
export type { BuildQueryOptions, BuiltQuery, FilterOp, GridStateInput, QueryErrorCode } from "./query";
export { gridAccess, gridPageAccess, gridQueryInTx, runGridQuery, visibleIn } from "./query/run";
export { DATA_PROCESSES, DATA_QUERY_MAX_ROWS, dataQuery } from "./query/data-query.process";
export type { FieldMode, GridAccess, GridExtraField, GridQueryOptions, GridResult, PartyScope } from "./query/run";
export { addRefLabels } from "./query/ref-labels";
export { SAVED_VIEW_PROCESS_IDS, SAVED_VIEW_PROCESSES, SavedViewState } from "./saved-views";
export type { SavedView } from "./saved-views";
export { IMPORT_PROCESSES, importList, importPreview, importRun, importTemplate } from "./import/processes";
export type { ImportItem } from "./import/processes";
export { importEntity } from "./import/entity";
export { importColumns, importTarget } from "./import/columns";
export type { ImportColumn, ImportColumnType } from "./import/columns";
export { exportsStore, fileStore, setExportsStore, setFileStore } from "./files/store";
export { consultProcessesOf, entitlementKeyOf, gridDenial, gridEntity, requireGridAccess } from "./query/access";
export type { GridDenial } from "./query/access";
export { EXPORT_PROCESSES, exportJobEntity } from "./exports";
export {
  buildHelpIndex,
  chunkGuide,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  embedQuery,
  FakeEmbedder,
  GatewayEmbedder,
  guideProblems,
  HELP_EMBED_TIMEOUT_MS,
  HELP_PROCESSES,
  helpEmbedder,
  helpSearch,
  installedHelpEmbedder,
  knownRoutes,
  loadGuides,
  processChunks,
  processHref,
  searchHelp,
  searchHelpByEmbedding,
  setHelpEmbedder,
} from "./help";
export type { EmbedOptions, Embedder, HelpIndexSummary, HelpResult } from "./help";
export { costUsd, DEFAULT_PRICE, MODEL_PRICES, priceOf, providerOfModel, recordLlmUsage } from "./ai/usage";
export type { EmbeddingUsage, LlmTask, LlmUsageRow, ModelPrice } from "./ai/usage";
export { ADMIN_FEATURE, ADMIN_PROCESSES, authAdmin, matrixProcess, matrixProcesses, moduleStates, readAiUsage, readPermissionMatrix, setAuthAdmin, syncRegistry } from "./admin";
export type { AiUsage, MatrixProcess, ModuleState, PermissionMatrix } from "./admin";
export { ADMIN_NAVIGATION } from "./admin/navigation";

export { aiTokensKpi, dailySeries, HOME_FEATURE, HOME_PROCESSES, homeKpis, homeRecent, KERNEL_KPI_PROVIDERS, kpiSchema, recommendationDecide, recommendationList, SERIES_DAYS, suggestedAction } from "./home";
export type { SuggestedAction } from "./home";
