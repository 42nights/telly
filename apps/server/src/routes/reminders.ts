// Reminder lifecycle routes (issue #28), mounted at `/api/families/:familyId`. The database schedules
// and prompts on its own timers; these handlers call reducers that check membership again, and
// answer each write from the caller's views only after the database has committed it.
import {
	type Reminder,
	ReminderAnswerInput,
	ReminderConfirmationInput,
	ReminderDeliveryInput,
	type ReminderHistory,
	ReminderInput,
	type ReminderOccurrenceDetail,
	ReminderSettings,
	type Reminders,
	type SavedReminderSettings,
} from "@health/contracts/reminders";
import { type Context, Hono } from "hono";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import {
	minuteOfDay,
	readReminderHistory,
	readReminderSettings,
	readReminders,
} from "../reminders/records";

const HISTORY_LIMIT = 200;

const occurrenceOf = (c: Context<FamilyEnv>) => {
	const found = readReminderHistory(
		c.var.db,
		c.var.familyId.toString(),
		c.req.param("occurrenceId"),
	)[0];
	if (found === undefined)
		throw new ApiFailure(
			"not_found",
			"No such reminder occurrence in this family",
		);
	return found;
};

const detail = (c: Context<FamilyEnv>) =>
	c.json(occurrenceOf(c) satisfies ReminderOccurrenceDetail);

export const reminderRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/reminder-settings", (c) =>
			c.json({
				settings: readReminderSettings(c.var.db, c.var.familyId.toString()),
			} satisfies SavedReminderSettings),
		)
		.put("/reminder-settings", async (c) => {
			const { db, familyId } = c.var;
			const input = await decodeBody(c, ReminderSettings);
			await callReducer(db, (connection) =>
				connection.reducers.setReminderSettings({
					familyId,
					timeZone: input.timeZone,
					quietStart:
						input.quietHours === null
							? undefined
							: minuteOfDay(input.quietHours.start),
					quietEnd:
						input.quietHours === null
							? undefined
							: minuteOfDay(input.quietHours.end),
					repeatEveryMinutes: input.repeatEveryMinutes,
					maxPrompts: input.maxPrompts,
					snoozeMinutes: input.snoozeMinutes,
				}),
			);
			const saved = readReminderSettings(db, familyId.toString());
			if (saved === null)
				throw new Error(
					"the reminder settings are not visible to their author",
				);
			return c.json(saved satisfies ReminderSettings);
		})
		.get("/reminders", (c) =>
			c.json({
				reminders: readReminders(c.var.db, c.var.familyId.toString()).map(
					({ reminder }) => reminder,
				),
			} satisfies Reminders),
		)
		.post("/reminders", async (c) => {
			const { db, familyId } = c.var;
			const input = await decodeBody(c, ReminderInput);
			if (readReminderSettings(db, familyId.toString()) === null)
				throw new ApiFailure("conflict", "Save the reminder settings first");
			const clientId = crypto.randomUUID();
			await callReducer(db, (connection) =>
				connection.reducers.createReminder({
					familyId,
					clientId,
					kind: input.kind,
					subjectId: input.subjectId ?? undefined,
					title: input.title,
					times: input.times.map(minuteOfDay),
				}),
			);
			const created = readReminders(db, familyId.toString()).find(
				(r) => r.clientId === clientId,
			);
			if (created === undefined)
				throw new Error("the reminder is not visible to its author");
			return c.json(created.reminder satisfies Reminder, 201);
		})
		.delete("/reminders/:reminderId", async (c) => {
			const { db } = c.var;
			const reminderId = c.req.param("reminderId");
			const found = readReminders(db, c.var.familyId.toString()).some(
				(r) => r.reminder.id === reminderId,
			);
			if (!found)
				throw new ApiFailure("not_found", "No such reminder in this family");
			await callReducer(db, (connection) =>
				connection.reducers.deleteReminder({ reminderId: BigInt(reminderId) }),
			);
			return c.body(null, 204);
		})
		.get("/reminder-occurrences", (c) =>
			c.json({
				occurrences: readReminderHistory(
					c.var.db,
					c.var.familyId.toString(),
				).slice(0, HISTORY_LIMIT),
			} satisfies ReminderHistory),
		)
		.get("/reminder-occurrences/:occurrenceId", detail)
		.post("/reminder-occurrences/:occurrenceId/deliveries", async (c) => {
			const { occurrence } = occurrenceOf(c);
			const input = await decodeBody(c, ReminderDeliveryInput);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.recordReminderDelivery({
					occurrenceId: BigInt(occurrence.id),
					...input,
				}),
			);
			return detail(c);
		})
		.post("/reminder-occurrences/:occurrenceId/answers", async (c) => {
			const { occurrence } = occurrenceOf(c);
			const input = await decodeBody(c, ReminderAnswerInput);
			const completes =
				input.response === "done" || input.response === "already_did_it";
			if (!completes && occurrence.nextPromptAt === null)
				throw new ApiFailure(
					"conflict",
					"Prompts have ended for this occurrence; only a completion still records",
				);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.answerReminder({
					occurrenceId: BigInt(occurrence.id),
					clientId: input.clientId,
					source: input.source,
					response: input.response,
					wording: input.wording ?? undefined,
				}),
			);
			return detail(c);
		})
		.post("/reminder-occurrences/:occurrenceId/confirmations", async (c) => {
			const { occurrence } = occurrenceOf(c);
			const input = await decodeBody(c, ReminderConfirmationInput);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.confirmReminder({
					occurrenceId: BigInt(occurrence.id),
					clientId: input.clientId,
					source: input.source,
					wording: input.wording ?? undefined,
				}),
			);
			return detail(c);
		});
