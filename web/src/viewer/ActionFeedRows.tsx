import React, { type ReactNode } from "react";

import {
  focusAndOpenPortal,
  setCursor,
  type RunTimeline,
} from "../store/timeline.js";
import { participantRef, type ActionFeedRow } from "./actionFeed.js";
import {
  actionDecider,
  actionDeciderPresentation,
  actionLivePresentation,
  declarationFacts,
  displayName,
  type ActionDecider,
} from "./actionNarration.js";
import { narrateAction } from "./actionNarrators.js";
import type { ActionLogEntry } from "./actionLog.js";
import type { CommitmentSpan } from "./commitmentSpans.js";

function Participant({
  participant,
  timeline,
}: {
  participant: string;
  timeline: RunTimeline;
}) {
  const ref = participantRef(timeline, participant);
  const name = displayName(participant);
  return ref === undefined ? <span title={participant}>{name}</span> : (
    <button
      className="feed-participant"
      onClick={() => focusAndOpenPortal(ref)}
      title={participant}
      type="button"
    >
      {name}
    </button>
  );
}

function Address({ value }: { value: string }) {
  return <span title={value}>{displayName(value)}</span>;
}

function RoleChip({
  decider,
  row,
}: {
  decider: ActionDecider;
  row?: ActionFeedRow;
}) {
  const presentation = actionDeciderPresentation(decider);
  // TODO(B273): src/view/** must plumb source.provenance /
  // source.live_acceptance onto the action event payload before this call can receive it.
  const live = row === undefined ? undefined : actionLivePresentation(row);
  const className = [
    "feed-role-chip",
    presentation.className,
    live?.className,
  ].filter(Boolean).join(" ");
  return (
    <span
      className={className}
      aria-label={`${presentation.word}${live?.token ?? ""} role`}
    >
      <span aria-hidden="true">{presentation.glyph}</span>{" "}
      {presentation.word}{live?.token}
    </span>
  );
}

function What({
  detail,
  hasDetail,
  headline,
  headlineText,
  message = false,
}: {
  detail: ReactNode;
  hasDetail: boolean;
  headline: ReactNode;
  headlineText: string;
  message?: boolean;
}) {
  const headlineClass = [
    "feed-headline",
    message ? "feed-headline-message" : undefined,
  ].filter(Boolean).join(" ");
  return hasDetail ? (
    <details className="feed-what">
      <summary className={headlineClass} title={headlineText}>
        {headline}
      </summary>
      <div className="feed-what-detail">{detail}</div>
    </details>
  ) : (
    <span className={`feed-what ${headlineClass}`} title={headlineText}>
      {headline}
    </span>
  );
}

export function StandingCommitmentRow({
  span,
  timeline,
}: {
  span: CommitmentSpan;
  timeline: RunTimeline;
}) {
  const presentation = actionDeciderPresentation("declared");
  // TODO(B279): a standing row states the recorded verb rather than narrated
  // prose, because `narrateAction` takes a row/declaration pair a span does not
  // carry. So the block above the log still reads as an internal name while the
  // log below it reads as prose. Deferred: giving spans a narration request is a
  // contract change, not a presentation fix.
  const headlineText = [
    span.verb,
    ...(span.counterparty === undefined
      ? []
      : [`to ${displayName(span.counterparty)}`]),
    ...(span.target === undefined || span.target === span.counterparty
      ? []
      : [`→ ${displayName(span.target)}`]),
  ].join(" ");
  // TODO(B273): The resolution badge below can state an outcome later than the
  // cursor; fixing that requires threading the cursor tick into this row.
  return (
    <article
      aria-label={`declared standing commitment at tick ${span.declaredAtTick}`}
      className={`feed-grid-row feed-standing-row ${presentation.className}`}
    >
      <span className="feed-tick">t{span.declaredAtTick}</span>
      <span className="feed-role"><RoleChip decider="declared" /></span>
      <span className="feed-actor">
        <Participant participant={span.participant} timeline={timeline} />
      </span>
      <What
        headlineText={headlineText}
        hasDetail
        headline={(
          <>
            <span>{span.verb}</span>
            {span.counterparty ? (
              <>
                {" "}<span className="feed-muted">to</span>{" "}
                <Participant
                  participant={span.counterparty}
                  timeline={timeline}
                />
              </>
            ) : null}
            {span.target && span.target !== span.counterparty
              ? <span>{" → "}<Address value={span.target} /></span>
              : null}
          </>
        )}
        detail={(
          <>
            {span.actor ? (
              <span className="feed-muted">
                via <Address value={span.actor} />
              </span>
            ) : null}
            <button
              className="feed-muted feed-inline-button"
              onClick={() => setCursor(span.t)}
              type="button"
            >
              declared t{span.declaredAtTick}
            </button>
          </>
        )}
      />
      <span className="feed-outcome">
        {span.resolution === undefined ? (
          <span className="feed-outcome-badge feed-muted">standing</span>
        ) : (
          <button
            aria-label={`derived ${span.resolution.outcome} at tick ${span.resolution.tick}`}
            className="feed-resolution-badge feed-role-derived"
            onClick={() => setCursor(span.resolution?.t ?? span.t)}
            type="button"
          >
            <RoleChip decider="derived" />
            <span>{span.resolution.outcome} t{span.resolution.tick}</span>
          </button>
        )}
      </span>
    </article>
  );
}

/** A resolution keeps its declaration context so it remains readable alone. */
export function ActionLogRow({
  entry,
  timeline,
}: {
  entry: ActionLogEntry;
  timeline: RunTimeline;
}) {
  const declaration = entry.declaration;
  const declarer = declaration?.participant ?? entry.participant;
  const decider = actionDecider(entry);
  // A mind declares; a derived outcome is the world speaking about the recorded
  // body, so only derived rows use their own participant in the actor column.
  const actorParticipant = decider === "derived"
    ? entry.participant
    : declarer;
  const via = declaration?.actor ?? entry.actor;
  const target = entry.target ?? declaration?.target;
  const input = entry.input ?? declaration?.input;
  const validUntilTick = entry.validUntilTick ?? declaration?.validUntilTick;
  const facts = declarationFacts(input);
  const narration = narrateAction({
    row: entry,
    ...(declaration === undefined ? {} : { declaration }),
  });
  const narrationTitle = [...new Set([
    actorParticipant,
    declarer,
    ...(via === undefined ? [] : [via]),
    ...(entry.counterparty === undefined ? [] : [entry.counterparty]),
    ...(target === undefined ? [] : [target]),
  ])].join(" · ");
  const narrationRef = participantRef(timeline, actorParticipant);
  const presentation = actionDeciderPresentation(decider);
  const accessibleNoun = decider === "derived" ? "outcome" : "action";
  const refusedCause = decider === "refused" ? entry.cause : undefined;
  const genericHeadlineText = [
    entry.verb,
    ...(entry.counterparty === undefined
      ? []
      : [`to ${displayName(entry.counterparty)}`]),
    ...(target === undefined || target === entry.counterparty
      ? []
      : [`→ ${displayName(target)}`]),
  ].join(" ");
  const headlineBase = narration?.text ?? genericHeadlineText;
  const headlineText = refusedCause === undefined
    ? headlineBase
    : `${headlineBase} · refused: ${refusedCause}`;
  const hasDetail = via !== undefined || facts.length > 0
    || narration?.note !== undefined
    || entry.phase === "action" && validUntilTick !== undefined
    || entry.phase === "commitment" && declaration !== undefined
    || entry.cause !== undefined && decider !== "refused"
    || entry.detail !== undefined;

  return (
    <article
      aria-label={`${presentation.word} ${accessibleNoun} at tick ${entry.tick}`}
      className={`feed-grid-row feed-log-row ${presentation.className}`}
    >
      <span className="feed-tick">t{entry.tick}</span>
      <span className="feed-role">
        <RoleChip decider={decider} row={entry} />
      </span>
      <span className="feed-actor">
        <Participant participant={actorParticipant} timeline={timeline} />
      </span>
      <What
        headlineText={headlineText}
        hasDetail={hasDetail}
        message={narration?.form === "message"}
        headline={(
          <>
            {narration === undefined ? (
              <>
                <span>{entry.verb}</span>
                {entry.counterparty ? (
                  <>
                    {" "}<span className="feed-muted">to</span>{" "}
                    <Participant
                      participant={entry.counterparty}
                      timeline={timeline}
                    />
                  </>
                ) : null}
                {target && target !== entry.counterparty
                  ? <span>{" → "}<Address value={target} /></span>
                  : null}
              </>
            ) : narrationRef === undefined ? (
              <span title={narrationTitle}>{narration.text}</span>
            ) : (
              <button
                className="feed-inline-button"
                onClick={() => focusAndOpenPortal(narrationRef)}
                title={narrationTitle}
                type="button"
              >
                {narration.text}
              </button>
            )}
            {refusedCause === undefined
              ? null
              : <span>{" · "}refused: {refusedCause}</span>}
          </>
        )}
        detail={(
          <>
            {via ? (
              <span className="feed-muted">via <Address value={via} /></span>
            ) : null}
            {narration?.note
              ? <span className="feed-muted">{narration.note}</span>
              : null}
            {facts.length > 0 ? (
              <span>
                {facts.map(({ label, value }) => `${label}: ${value}`).join(", ")}
              </span>
            ) : null}
            {entry.phase === "action" && validUntilTick !== undefined
              ? <span className="feed-muted">until t{validUntilTick}</span>
              : null}
            {entry.phase === "commitment" && declaration !== undefined ? (
              <button
                className="feed-muted feed-inline-button"
                onClick={() => setCursor(declaration.t)}
                type="button"
              >
                declared t{declaration.tick}
              </button>
            ) : null}
            {entry.cause !== undefined && decider !== "refused" ? (
              <span className="feed-muted">mechanics: {entry.cause}</span>
            ) : null}
            {entry.detail
              ? <span className="feed-muted">({entry.detail})</span>
              : null}
          </>
        )}
      />
      <span className="feed-outcome">
        <button
          aria-label={`${entry.outcome} at tick ${entry.tick}`}
          className="feed-outcome-badge"
          onClick={() => setCursor(entry.t)}
          type="button"
        >
          {entry.outcome}
        </button>
      </span>
    </article>
  );
}
