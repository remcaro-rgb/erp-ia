---
tags: [resource, database]
date: 2026-11-07
status: active
---

# Migrations catalog

124 forward-only migrations in `supabase/migrations/` (rule: never edit an applied one).

## .keep (1)
- `.keep`

## accounting (26)
- `0031_accounting_masters.sql`
- `0032_accounting_ledger.sql`
- `0033_accounting_views.sql`
- `0034_accounting_entry_reversal.sql`
- `0035_accounting_attachments_hook.sql`
- `0036_accounting_period_figures.sql`
- `0038_accounting_account_invoice_ready.sql`
- `0039_accounting_account_view_invoice_ready.sql`
- `0043_accounting_entries_typed.sql`
- `0046_accounting_record_access.sql`
- `0054_accounting_period_figure_fast.sql`
- `0055_accounting_template_options.sql`
- `0057_accounting_account_visibility_set_based.sql`
- `0058_accounting_master_tree_materialized.sql`
- `0059_accounting_ledger_readers_set_based.sql`
- `0064_accounting_entry_lines_view_once.sql`
- `0071_accounting_inventory_rule_when.sql`
- `0076_accounting_cogs_rule_source.sql`
- `0089_accounting_voided_sources.sql`
- `0098_accounting_note_rules_split.sql`
- `0110_accounting_payment_rules.sql`
- `0112_accounting_open_items_from_allocations.sql`
- `0114_accounting_open_items_fix_round_1.sql`
- `0115_accounting_note_rules_retire_combined.sql`
- `0117_accounting_rules_retag_module.sql`
- `0118_accounting_rule_stale_days.sql`

## core (13)
- `0006_core_master_data.sql`
- `0010_core_custom_field_hook.sql`
- `0037_core_party_readiness.sql`
- `0042_core_masters_typed.sql`
- `0045_core_record_access.sql`
- `0065_core_document_resolutions.sql`
- `0067_core_product_stock.sql`
- `0070_core_product_stock_cost.sql`
- `0072_core_product_costs_fn.sql`
- `0081_core_sales_facts.sql`
- `0091_core_invoicing_facts.sql`
- `0100_core_document_sequence_register.sql`
- `0104_core_resolution_keys.sql`

## costing (4)
- `0073_costing_core.sql`
- `0075_costing_reconcile.sql`
- `0077_costing_landed.sql`
- `0086_costing_voids.sql`

## crm (2)
- `0079_crm_core.sql`
- `0080_crm_row_isolation.sql`

## einvoice (1)
- `0102_einvoice_environment_and_key.sql`

## inventory (5)
- `0066_inventory_core.sql`
- `0068_inventory_review.sql`
- `0069_inventory_transfers_counts.sql`
- `0074_inventory_movement_feed.sql`
- `0087_inventory_sale_stock.sql`

## invoicing (12)
- `0092_invoicing_core.sql`
- `0094_invoicing_fix_round_1.sql`
- `0095_invoicing_einvoice.sql`
- `0096_invoicing_notes.sql`
- `0097_invoicing_notes_fix_round_1.sql`
- `0101_invoicing_parametros.sql`
- `0103_invoicing_certificate_fingerprint.sql`
- `0105_invoicing_production_guard.sql`
- `0107_invoicing_pending_lines.sql`
- `0108_invoicing_payment_facts.sql`
- `0113_invoicing_paid_status.sql`
- `0121_invoicing_price_date.sql`

## kernel (52)
- `0001_kernel_tenancy.sql`
- `0002_kernel_audit_outbox.sql`
- `0003_kernel_field_permissions.sql`
- `0004_kernel_process_security.sql`
- `0005_kernel_entitlements.sql`
- `0007_kernel_attachments.sql`
- `0008_kernel_custom_fields.sql`
- `0009_kernel_verifiers.sql`
- `0011_kernel_auth_attempts.sql`
- `0012_kernel_user_prefs.sql`
- `0013_kernel_saved_views.sql`
- `0014_kernel_imports.sql`
- `0015_kernel_import_visibility.sql`
- `0016_kernel_export_jobs.sql`
- `0018_kernel_help_index.sql`
- `0019_kernel_agent.sql`
- `0020_kernel_agent_hardening.sql`
- `0021_kernel_admin.sql`
- `0022_kernel_recommendations.sql`
- `0023_kernel_audit_view.sql`
- `0024_kernel_role_claims.sql`
- `0025_kernel_audit_source_and_user_state.sql`
- `0026_kernel_v_users.sql`
- `0027_kernel_user_update.sql`
- `0028_kernel_mfa_exempt.sql`
- `0029_kernel_mfa_reset_guard.sql`
- `0030_kernel_saved_views_reports.sql`
- `0040_kernel_typed_entities.sql`
- `0041_kernel_record_usable.sql`
- `0044_kernel_record_access.sql`
- `0047_kernel_menu_access.sql`
- `0048_kernel_doc_templates.sql`
- `0049_kernel_state_mail.sql`
- `0050_kernel_record_authors.sql`
- `0051_kernel_record_versions.sql`
- `0052_kernel_state_recipients_read.sql`
- `0053_kernel_audit_log_record_reads.sql`
- `0056_kernel_mfa_required_passwords.sql`
- `0060_kernel_field_mode_fast.sql`
- `0061_kernel_manifest_hashes.sql`
- `0062_kernel_runnable_processes.sql`
- `0063_kernel_field_modes.sql`
- `0078_kernel_inline_posting.sql`
- `0088_kernel_dismiss_events_lock.sql`
- `0090_kernel_outbox_source_indexes.sql`
- `0099_kernel_vault_secrets.sql`
- `0106_kernel_secret_fingerprint.sql`
- `0116_kernel_definer_process_guards.sql`
- `0119_kernel_dry_run_denial_counters.sql`
- `0120_kernel_parked_events.sql`
- `0122_kernel_outbox_company_event_created_idx.sql`
- `0123_kernel_recommendation_api.sql`

## payments (2)
- `0109_payments_core.sql`
- `0111_payments_fix_round_1.sql`

## sales (5)
- `0082_sales_quotes.sql`
- `0083_sales_readiness_usable.sql`
- `0084_sales_orders.sql`
- `0085_sales_deliveries.sql`
- `0093_sales_invoicing_link.sql`

## support (1)
- `0017_support_tickets.sql`
