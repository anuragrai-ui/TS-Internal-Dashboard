import { Icon } from "@/components/Icon";
import { personKey, slackDmUrl } from "@/components/oncall/format";

import type { OnCallShift } from "@/lib/workspace/types";

interface OnCallPeopleProps {
  shift: OnCallShift;
  /* Larger names on the page's "Now" cards. */
  size?: "lg" | "md";
}

/**
 * The people on a shift, each with a "message in Slack" link when the Slack
 * directory matched them. A shift that names nobody shows its calendar
 * title instead, so it is never silently blank.
 */
export function OnCallPeople({ shift, size = "md" }: OnCallPeopleProps): React.ReactElement {
  if (shift.people.length === 0) {
    return (
      <span className="oc-people oc-people-empty" data-size={size}>
        Nobody listed <span className="oc-muted">({shift.title})</span>
      </span>
    );
  }

  return (
    <span className="oc-people" data-size={size}>
      {shift.people.map((person, index) => {
        const dm = slackDmUrl(person.slackUserId);
        return (
          <span className="oc-person" key={personKey(person, index)}>
            {dm ? (
              <a
                aria-label={`Message ${person.name} in Slack (opens Slack)`}
                className="oc-person-link"
                href={dm}
                rel="noreferrer"
                target="_blank"
                title={`Message ${person.name} in Slack`}
              >
                {person.name}
                <Icon name="message" size={size === "lg" ? 14 : 12} />
              </a>
            ) : (
              <span className="oc-person-name" title={person.email}>
                {person.name}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
