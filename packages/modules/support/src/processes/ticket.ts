import { defineProcess, ProcessError, visibleExtra, type Tx } from "@erp/kernel";
import { z } from "zod";
import { TICKET_KINDS } from "../entities";

// Support tickets (design §8): a user files a ticket (a bug, a question or a request) with the context the client
// captured, a conversation follows, an agent closes it. Visibility is the ownership row policy of migration 0017: a
// reporter reaches only their own tickets, an agent (whoever may close tickets) reaches every ticket of the company
// and the internal notes. Every read below goes through the masked views, so field visibility holds in all channels.

const FEATURE = "support.tickets";

const id = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);

/** What the client captured when the ticket was filed (all of it optional, all of it bounded). */
export const ticketContext = z.object({
  route: z.string().max(500).default(""),
  selection: z.string().max(2000).default(""),
  lastAuditIds: z.array(z.uuid()).max(20).default([]),
  consoleErrors: z.array(z.string().max(1000)).max(20).default([]),
});

const idInput = z.object({ id });
const idOutput = z.object({ id: z.string() });

/** True when the caller may close tickets: a support agent, who reads every ticket of the company. */
async function isAgent(ctx: { tx: Tx }): Promise<boolean> {
  const [row] = await ctx.tx<{ agent: boolean }[]>`select support.is_agent() as agent`;
  return row?.agent === true;
}

/** The status of a ticket the caller can see, locked for the rest of the transaction; `not_found` for one they cannot. */
async function lockedTicket(ctx: { tx: Tx }, ticketId: string): Promise<{ status: string }> {
  const [ticket] = await ctx.tx<{ status: string }[]>`select status from support.tickets where id = ${ticketId} for update`;
  if (!ticket) throw new ProcessError("not_found", `ticket ${ticketId} not found`);
  return ticket;
}

const closedRefusal = (processId: string) =>
  new ProcessError("invalid_input", `ticket is closed (${processId})`, { details: ["El ticket está cerrado"] });

export const ticketCreate = defineProcess({
  id: "support.ticket.create",
  module: "support",
  kind: "create",
  feature: FEATURE,
  description: "Abre un ticket de soporte (error, pregunta o solicitud) con el contexto capturado de la pantalla",
  input: z.object({
    kind: z.enum(TICKET_KINDS),
    title: text(200),
    body: text(10_000),
    context: ticketContext.optional(),
  }),
  output: idOutput,
  handler: async (ctx, input) => {
    const [inserted] = await ctx.tx<{ id: string }[]>`
      insert into support.tickets ${ctx.tx({
        company_id: ctx.companyId,
        reporter_user_id: ctx.userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        context: ctx.tx.json(input.context ?? {}),
      })}
      returning id`;
    await ctx.emit("support.ticket.created", { id: inserted!.id, kind: input.kind });
    return { id: inserted!.id };
  },
});

export const ticketReply = defineProcess({
  id: "support.ticket.reply",
  module: "support",
  kind: "update",
  feature: FEATURE,
  description: "Responde en la conversación de un ticket; un agente puede dejar una nota interna que el solicitante no ve",
  input: z.object({ ticketId: id, body: text(10_000), isInternal: z.boolean().default(false) }),
  output: z.object({ id: z.string(), status: z.string() }),
  handler: async (ctx, { ticketId, body, isInternal }) => {
    const ticket = await lockedTicket(ctx, ticketId);
    if (ticket.status === "closed") throw closedRefusal("support.ticket.reply");
    const agent = await isAgent(ctx);
    if (isInternal && !agent) {
      throw new ProcessError("forbidden", "only a support agent writes internal notes", { details: ["Solo un agente de soporte puede dejar notas internas"] });
    }
    const [message] = await ctx.tx<{ id: string }[]>`
      insert into support.ticket_messages ${ctx.tx({ company_id: ctx.companyId, ticket_id: ticketId, author_user_id: ctx.userId, body, is_internal: isInternal })}
      returning id`;
    // An agent's answer waits on the reporter; the reporter's follow-up waits on the agents; a note changes nothing.
    const status = isInternal ? ticket.status : agent ? "answered" : "open";
    if (status !== ticket.status) await ctx.tx`update support.tickets set status = ${status} where id = ${ticketId}`;
    return { id: message!.id, status };
  },
});

export const ticketClose = defineProcess({
  id: "support.ticket.close",
  module: "support",
  kind: "update",
  feature: FEATURE,
  description: "Cierra un ticket de soporte; un ticket cerrado no recibe más respuestas",
  input: idInput,
  output: idOutput,
  handler: async (ctx, { id: ticketId }) => {
    const ticket = await lockedTicket(ctx, ticketId);
    if (ticket.status === "closed") throw closedRefusal("support.ticket.close");
    await ctx.tx`update support.tickets set status = 'closed' where id = ${ticketId}`;
    return { id: ticketId };
  },
});

export const ticketConsult = defineProcess({
  id: "support.ticket.consult",
  module: "support",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un ticket con su conversación y los campos que el rol puede ver; el solicitante ve el suyo y un agente todos",
  input: idInput,
  output: z.looseObject({ id: z.string(), messages: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: ticketId }) => {
    const [row] = await ctx.tx`select * from support.v_tickets where id = ${ticketId}`;
    if (!row) throw new ProcessError("not_found", `ticket ${ticketId} not found`);
    const messages = await ctx.tx<{ id: string }[]>`select * from support.v_ticket_messages where ticket_id = ${ticketId} order by seq`;
    return { ...row, id: ticketId, extra: await visibleExtra(ctx, "support.ticket", row.extra), messages };
  },
});

export const ticketMessageConsult = defineProcess({
  id: "support.ticket_message.consult",
  module: "support",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un mensaje de un ticket con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: messageId }) => {
    const [row] = await ctx.tx`select * from support.v_ticket_messages where id = ${messageId}`;
    if (!row) throw new ProcessError("not_found", `ticket message ${messageId} not found`);
    return { ...row, id: messageId };
  },
});

export const TICKET_PROCESSES = [ticketCreate, ticketReply, ticketClose, ticketConsult, ticketMessageConsult];
