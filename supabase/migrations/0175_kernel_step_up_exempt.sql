-- 0175_kernel_step_up_exempt
-- Forward-only migration (rule 34). Covered by packages/kernel/src/admin/__tests__/admin.integration.test.ts («sensitive_process.set …»
-- and «sensitive_process.set_all …») and packages/kernel/src/__tests__/run-process.integration.test.ts («an exempt step-up process …»).
-- Owner decision 2026-11-11 (design §22, rule 15 amended): the admin decides the step-up of EVERY process in the company, also of the
-- processes whose definition asks for it (the administration processes, approvals…). Such a process the admin switched off keeps a row of
-- mode `exempt` in kernel.sensitive_processes: runProcess and the assistant's confirmation card ask for the code when the company marked
-- the process (`self_2fa`, `supervisor`), or when the definition asks for it and the company did not exempt it. A process without a row
-- keeps what its definition says. kernel.sync_sensitive_defaults inserts `on conflict do nothing`, so an exemption survives a module
-- enable or a new admin process sync.

alter table kernel.sensitive_processes drop constraint if exists sensitive_processes_mode_check;
alter table kernel.sensitive_processes add constraint sensitive_processes_mode_check check (mode in ('self_2fa', 'supervisor', 'exempt'));
