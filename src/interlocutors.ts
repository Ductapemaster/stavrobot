import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { getOwnerInterlocutorId } from "./database.js";
import { encodeToToon } from "./toon.js";

const HELP_TEXT = `manage_interlocutors tool — full documentation

Actions:

help — Show this documentation.

create — Create a new interlocutor.
  display_name (required): Human-readable name. Must be unique.
  agent_id (optional): ID of the agent that handles inbound messages from this interlocutor. If not set, inbound messages are dropped.
  service (optional): Channel name, e.g. "signal" or "telegram".
  identifier (optional): Channel-native ID, e.g. phone number or Telegram chat ID.
  If service and identifier are provided, the identity is created along with the interlocutor.
  Both must be present or both absent.
  Returns the created interlocutor's ID. New interlocutors are enabled by default.

update — Update an existing interlocutor's fields. Only provided fields are updated. Refuses to modify the owner record.
  id (required): Interlocutor ID.
  display_name (optional): New display name.
  agent_id (optional): New agent assignment. Use 0 to clear the agent assignment (inbound messages will be dropped).
  enabled (optional): Boolean. Set to false to disable the interlocutor (inbound messages dropped, outbound blocked). Set to true to re-enable.

delete — Remove all channel identities from an interlocutor (the interlocutor row is kept). Refuses to operate on the owner.
  id (required): Interlocutor ID.

add_identity — Add a channel identity to an existing interlocutor. Refuses to modify the owner's identities (those are managed by the config file).
  id (required): Interlocutor ID.
  service (required): Channel name, e.g. "signal" or "telegram".
  identifier (required): Channel-native ID, e.g. phone number or Telegram chat ID.

remove_identity — Soft-delete a channel identity (nulls out the identifier, keeps the row). Refuses to modify the owner's identities.
  id (required): Interlocutor ID.
  service (required): Channel name.
  identifier (required): Channel-native ID.

list — List all interlocutors with their identities. Shows owner: true/false and enabled: true/false. No parameters.

---

Guidance on talking to people:

Interlocutors are contact records — people the bot can communicate with. Each has a display name, optional channel identities (service + identifier), and an optional agent assignment. An identity is basically a way to communicate with an interlocutor on a given service (e.g. their Signal username).

To talk to another person to complete some task:
1. Create an interlocutor record with their display name and channel identity (service + identifier).
2. Create a subagent via manage_agents with instructions for the task (language, topic, context, constraints). Give it only the bare minimum of tools it needs to complete the task (e.g. send_telegram_message, google_calendar).
3. Assign the subagent to the interlocutor by setting agent_id on the interlocutor. This allows messages from the person to be routed to the agent.
4. Send the subagent its first message via send_agent_message. The subagent will handle the conversation in its own context and can message you back if it needs information or tools.
5. When the task is done, disable the interlocutor (set enabled: false). This stops both inbound and outbound messages. The agent assignment stays in place, so you can re-enable the interlocutor later to resume.

The agent_id determines which agent handles inbound messages from this interlocutor. If agent_id is null or the interlocutor is disabled, inbound messages are dropped.`;

export function createManageInterlocutorsTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_interlocutors",
    label: "Manage interlocutors",
    description: `Manage interlocutors — contact records for people the bot can communicate with. Each interlocutor has a display name, one or more channel identities (service + identifier), and an optional agent assignment that determines which agent handles their inbound messages. Use the "help" action to learn how to use this tool.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("help"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("add_identity"),
        Type.Literal("remove_identity"),
        Type.Literal("list"),
      ]),
      display_name: Type.Optional(Type.String()),
      agent_id: Type.Optional(Type.Number()),
      enabled: Type.Optional(Type.Boolean()),
      id: Type.Optional(Type.Number()),
      service: Type.Optional(Type.String()),
      identifier: Type.Optional(Type.String()),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        display_name?: string;
        agent_id?: number;
        enabled?: boolean;
        id?: number;
        service?: string;
        identifier?: string;
      };

      const { action } = raw;

      console.log(`[stavrobot] manage_interlocutors called: action=${action} id=${raw.id}`);
      if (process.env.STAVROBOT_DEBUG === "1") {
        console.log(`[stavrobot] [debug] manage_interlocutors: ${JSON.stringify(raw)}`);
      }

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: HELP_TEXT }],
          details: { message: HELP_TEXT },
        };
      }

      if (action === "create") {
        if (raw.display_name === undefined || raw.display_name.trim() === "") {
          const errorMessage = "Error: display_name is required for create.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        const hasService = raw.service !== undefined && raw.service.trim() !== "";
        const hasIdentifier = raw.identifier !== undefined && raw.identifier.trim() !== "";
        if (hasService !== hasIdentifier) {
          const errorMessage = "Error: service and identifier must both be provided or both absent.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const client = await pool.connect();
        let newId: number;
        try {
          await client.query("BEGIN");
          const result = await client.query<{ id: number }>(
            "INSERT INTO interlocutors (display_name, agent_id) VALUES ($1, $2) RETURNING id",
            [raw.display_name.trim(), raw.agent_id ?? null],
          );
          newId = result.rows[0].id;
          if (hasService && hasIdentifier) {
            await client.query(
              `INSERT INTO interlocutor_identities (interlocutor_id, service, identifier) VALUES ($1, $2, $3)
               ON CONFLICT (service, identifier) WHERE identifier IS NOT NULL DO NOTHING`,
              [newId, raw.service!.trim(), raw.identifier!.trim()],
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }

        const message = `Interlocutor ${newId} created.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "update") {
        if (raw.id === undefined) {
          const errorMessage = "Error: id is required for update.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.id === getOwnerInterlocutorId()) {
          const errorMessage = "Error: Cannot modify the owner interlocutor.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const setClauses: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (raw.display_name !== undefined) {
          setClauses.push(`display_name = $${paramIndex++}`);
          values.push(raw.display_name.trim());
        }
        if (raw.agent_id !== undefined) {
          setClauses.push(`agent_id = $${paramIndex++}`);
          // 0 is a sentinel meaning "clear the agent assignment".
          values.push(raw.agent_id === 0 ? null : raw.agent_id);
        }
        if (raw.enabled !== undefined) {
          setClauses.push(`enabled = $${paramIndex++}`);
          values.push(raw.enabled);
        }

        if (setClauses.length === 0) {
          const errorMessage = "Error: no fields to update. Provide at least one of display_name, agent_id, or enabled.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        values.push(raw.id);
        await pool.query(
          `UPDATE interlocutors SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
          values,
        );

        const message = `Interlocutor ${raw.id} updated.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "delete") {
        if (raw.id === undefined) {
          const errorMessage = "Error: id is required for delete.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.id === getOwnerInterlocutorId()) {
          const errorMessage = "Error: Cannot modify the owner interlocutor.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        await pool.query(
          "UPDATE interlocutor_identities SET identifier = NULL WHERE interlocutor_id = $1",
          [raw.id],
        );

        const message = `Identities removed from interlocutor ${raw.id}.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "add_identity") {
        if (raw.id === undefined) {
          const errorMessage = "Error: id is required for add_identity.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.id === getOwnerInterlocutorId()) {
          const errorMessage = "Error: Cannot modify the owner interlocutor.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.service === undefined || raw.service.trim() === "") {
          const errorMessage = "Error: service is required for add_identity.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.identifier === undefined || raw.identifier.trim() === "") {
          const errorMessage = "Error: identifier is required for add_identity.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        await pool.query(
          `INSERT INTO interlocutor_identities (interlocutor_id, service, identifier) VALUES ($1, $2, $3)
           ON CONFLICT (service, identifier) WHERE identifier IS NOT NULL DO NOTHING`,
          [raw.id, raw.service.trim(), raw.identifier.trim()],
        );

        const message = `Identity added to interlocutor ${raw.id}.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "remove_identity") {
        if (raw.id === undefined) {
          const errorMessage = "Error: id is required for remove_identity.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.id === getOwnerInterlocutorId()) {
          const errorMessage = "Error: Cannot modify the owner interlocutor.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.service === undefined || raw.service.trim() === "") {
          const errorMessage = "Error: service is required for remove_identity.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.identifier === undefined || raw.identifier.trim() === "") {
          const errorMessage = "Error: identifier is required for remove_identity.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        await pool.query(
          "UPDATE interlocutor_identities SET identifier = NULL WHERE interlocutor_id = $1 AND service = $2 AND identifier = $3",
          [raw.id, raw.service.trim(), raw.identifier.trim()],
        );

        const message = `Identity removed from interlocutor ${raw.id}.`;
        console.log(`[stavrobot] ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "list") {
        const result = await pool.query<{
          id: number;
          display_name: string;
          agent_id: number | null;
          owner: boolean;
          enabled: boolean;
          created_at: Date;
          service: string | null;
          identifier: string | null;
        }>(
          `SELECT i.id, i.display_name, i.agent_id, i.owner, i.enabled, i.created_at,
                  ii.service, ii.identifier
           FROM interlocutors i
           LEFT JOIN interlocutor_identities ii ON ii.interlocutor_id = i.id AND ii.identifier IS NOT NULL
           ORDER BY i.id, ii.id`,
        );

        const ownerInterlocutorId = getOwnerInterlocutorId();

        // Group identities by interlocutor.
        const interlocutorMap = new Map<number, {
          id: number;
          display_name: string;
          agent_id: number | null;
          owner: boolean;
          enabled: boolean;
          created_at: Date;
          identities: Array<{ service: string; identifier: string }>;
        }>();

        for (const row of result.rows) {
          if (!interlocutorMap.has(row.id)) {
            interlocutorMap.set(row.id, {
              id: row.id,
              display_name: row.display_name,
              agent_id: row.agent_id,
              owner: row.id === ownerInterlocutorId,
              enabled: row.enabled,
              created_at: row.created_at,
              identities: [],
            });
          }
          if (row.service !== null && row.identifier !== null) {
            interlocutorMap.get(row.id)!.identities.push({
              service: row.service,
              identifier: row.identifier,
            });
          }
        }

        const interlocutors = Array.from(interlocutorMap.values());
        const message = encodeToToon(interlocutors);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      const errorMessage = `Error: unknown action '${action}'. Valid actions: help, create, update, delete, add_identity, remove_identity, list.`;
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        details: { message: errorMessage },
      };
    },
  };
}
