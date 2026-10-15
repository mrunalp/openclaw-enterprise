import { button, element } from "../dom.mjs";
import { DELETE_CONFIRMATION, keptResourcesText } from "./deletion.mjs";
import {
  NEUTRAL_DEPLOYMENT_NOTES,
  deploymentOutcome,
  displayDate,
  link,
  message,
  namespacePath,
  neutralDeploymentOutcome,
  shortId,
} from "./list.mjs";
import { STOP_CONFIRMATION } from "./stop.mjs";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Stroke icons on a 24-unit grid: a square for Stop and a trash can for Delete.
const ACTION_ICONS = {
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
  delete: [
    ["path", { d: "M4 7h16" }],
    ["path", { d: "M10 11v6M14 11v6" }],
    ["path", { d: "M6 7l1 13h10l1-13" }],
    ["path", { d: "M9 7V4h6v3" }],
  ],
};

function actionIcon(name) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  const attributes = {
    class: "action-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [key, value] of Object.entries(attributes)) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, shapeAttributes] of ACTION_ICONS[name]) {
    const shape = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [key, value] of Object.entries(shapeAttributes)) {
      shape.setAttribute(key, String(value));
    }
    svg.append(shape);
  }
  return svg;
}

// Revisions list newest first, one page at a time (finding 1323). A page can be empty when
// its revisions are not readable to the viewer, so follow the cursor to the newest readable one.
async function latestReadableRevision(context, path) {
  let cursor = null;
  do {
    const page = await context.request(
      cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      { includeMeta: true },
    );
    if (page.data.length > 0) {
      return page.data[0];
    }
    cursor = page.meta?.nextCursor ?? null;
  } while (cursor);
  return null;
}

export function renderAgentList(context) {
  const { view } = context;
  // Row actions replace an Agent with the API's response, so the table shows its new state.
  const items = [...context.items];
  const search = element("input", {
    type: "search",
    "aria-label": "Search Agents",
    placeholder: "Search Agents by name or ID",
  });
  search.value = context.drafts.get("agent-search") ?? "";
  context.drafts.track("agent-search", () => search.value || undefined);
  const rows = element("div");
  const feedback = element("div", { className: "agent-list-feedback" });
  const deployments = new Map();
  // Agents whose last row action had a conflicting or unconfirmed outcome. Their actions stay
  // disabled until Refresh rereads the list, so the console never repeats an uncertain write.
  const unsettled = new Set();
  const rowControls = new Map();
  const create = button("Create Agent", () => context.navigate("agents/new"), {
    className: "primary",
  });
  const createNote = element(
    "p",
    { className: "muted", role: "status", hidden: true },
    "Your access does not include creating Agents in this Namespace.",
  );
  view.replaceChildren(
    element("div", { className: "agent-toolbar" }, search, create),
    createNote,
    feedback,
    rows,
  );
  // Gating only: the API still authorizes creation, so an unknown answer keeps the control.
  void context.request(`${namespacePath(context.namespaceId)}/permissions`).then(
    (permissions) => {
      if (context.isCurrent() && permissions?.agents?.create === false) {
        create.disabled = true;
        createNote.hidden = false;
      }
    },
    () => {},
  );

  const agentPath = (id) =>
    `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(id)}`;

  function showOutcome({ notice, error, requestId }) {
    feedback.replaceChildren(
      ...(notice ? [element("p", { className: "notice", role: "status" }, notice)] : []),
      ...(error
        ? [
            element(
              "div",
              { className: "error", role: "alert" },
              element("p", {}, error),
              requestId
                ? element("p", { className: "request-id" }, `Request ID: ${requestId}`)
                : null,
            ),
          ]
        : []),
    );
  }

  function replaceItem(next) {
    const index = items.findIndex((item) => item.id === next.id);
    if (index !== -1) {
      items[index] = next;
    }
    render();
  }

  function focusRow(id, kind) {
    const controls = rowControls.get(id);
    if (!controls) {
      search.focus();
    } else if (!controls[kind].disabled) {
      controls[kind].focus();
    } else {
      controls.name.focus();
    }
  }

  function reportFailure(item, error, kind) {
    if (!context.isCurrent()) {
      return;
    }
    if (error.status === 401) {
      context.onExpired();
      return;
    }
    let text;
    if (error.status === 403) {
      text =
        kind === "stop"
          ? `You do not have permission to stop ${item.name}. Ask an administrator for Agent operate access.`
          : `You do not have permission to delete ${item.name}. Ask an administrator for Agent delete access.`;
    } else if ([400, 429].includes(error.status)) {
      text = message(error, true);
    } else {
      unsettled.add(item.id);
      if (error.status === 404) {
        text = `${item.name} is no longer available. Select Refresh to update the list.`;
      } else if (error.status === 409) {
        text = `${item.name} changed while the request was sent. Select Refresh before trying again.`;
      } else {
        text = `Outcome unknown. ${kind === "stop" ? "Stop" : "Deletion"} may have been accepted for ${item.name}. Select Refresh before trying again.`;
      }
    }
    showOutcome({ error: text, requestId: error.requestId });
    render();
  }

  async function stopAgent(item) {
    try {
      const stopped = await context.request(`${agentPath(item.id)}/stop`, { method: "POST" });
      if (!context.isCurrent()) {
        return;
      }
      if (
        stopped?.status !== "deleting" &&
        (stopped?.status !== "active" || stopped.desiredRuntimeState !== "stopped")
      ) {
        throw new Error("Invalid Agent stop response");
      }
      replaceItem(stopped);
      showOutcome({
        notice:
          stopped.status === "deleting"
            ? `${item.name} is being deleted.`
            : `Stop requested for ${item.name}. OCC will not start it again until you deploy a new version. Runtime shutdown completion is not exposed in Console.`,
      });
    } catch (error) {
      reportFailure(item, error, "stop");
    }
  }

  async function deleteAgent(item) {
    try {
      const deleting = await context.request(agentPath(item.id), { method: "DELETE" });
      if (!context.isCurrent()) {
        return;
      }
      if (deleting?.status !== "deleting") {
        throw new Error("Invalid deletion response");
      }
      replaceItem(deleting);
      showOutcome({
        notice: `Deletion requested for ${item.name}. It leaves this list once cleanup finishes; select Refresh to check.`,
      });
    } catch (error) {
      reportFailure(item, error, "delete");
    }
  }

  function confirmAction(item, kind, invoker) {
    const stopping = kind === "stop";
    const descriptions = stopping
      ? [STOP_CONFIRMATION]
      : [DELETE_CONFIRMATION, keptResourcesText(item)];
    const dialog = element("dialog", {
      className: stopping ? "agent-stop-dialog" : "agent-delete-dialog",
      "aria-labelledby": "agent-row-confirm-title",
      "aria-describedby": descriptions
        .map((_, index) => `agent-row-confirm-description-${index}`)
        .join(" "),
    });
    let pending = false;
    let submitted = false;
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      stopping ? "Stop Agent" : "Permanently delete Agent",
      async () => {
        pending = true;
        submitted = true;
        cancel.disabled = true;
        confirm.disabled = true;
        confirm.textContent = stopping ? "Stopping…" : "Deleting…";
        await (stopping ? stopAgent(item) : deleteAgent(item));
        pending = false;
        dialog.close();
      },
      { className: "danger" },
    );
    dialog.append(
      element(
        "h2",
        { id: "agent-row-confirm-title" },
        `${stopping ? "Stop" : "Delete"} ${item.name}?`,
      ),
      ...descriptions.map((text, index) =>
        element("p", { id: `agent-row-confirm-description-${index}` }, text),
      ),
      element("div", { className: "form-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if (pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        if (!context.isCurrent()) {
          return;
        }
        if (submitted) {
          focusRow(item.id, kind);
        } else if (invoker.isConnected) {
          invoker.focus();
        }
      },
      { once: true },
    );
    view.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  function rowActions(item) {
    // A deleting Agent keeps its retry and status controls on its detail page.
    const available = item.status !== "deleting" && !unsettled.has(item.id);
    const stopped = item.desiredRuntimeState === "stopped";
    const stop = button(
      actionIcon("stop"),
      (event) => confirmAction(item, "stop", event.currentTarget),
      {
        className: "icon-button",
        "aria-label": `Stop ${item.name}`,
        title: stopped ? (item.activeRevisionId ? "Stop requested" : "Not running") : "Stop Agent",
        disabled: !available || stopped,
      },
    );
    const remove = button(
      actionIcon("delete"),
      (event) => confirmAction(item, "delete", event.currentTarget),
      {
        className: "icon-button",
        "aria-label": `Delete ${item.name}`,
        title: "Delete Agent",
        disabled: !available,
      },
    );
    return { stop, delete: remove };
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const matches = items
      .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!matches.length) {
      rows.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          element("h2", {}, query ? "No matching Agents" : "No Agents yet"),
          element(
            "p",
            {},
            query
              ? "Try another name or ID."
              : "Create an Agent in this Namespace using an editable Configuration template.",
          ),
        ),
      );
      return;
    }
    const table = element("table", { className: "agent-table", "aria-label": "Agents" });
    table.append(
      element(
        "thead",
        {},
        element(
          "tr",
          {},
          ...[
            "Agent",
            "Execution mode",
            "Current version",
            "Latest deployment",
            "Created",
            "Actions",
          ].map((label) => element("th", { scope: "col" }, label)),
        ),
      ),
    );
    const body = element("tbody");
    rowControls.clear();
    for (const item of matches) {
      const name = link(item.name, `agents/${item.id}`, context);
      const actions = rowActions(item);
      rowControls.set(item.id, { name, ...actions });
      const deployment = element("td", {}, "Reading deployment…");
      if (!deployments.has(item.id)) {
        deployments.set(
          item.id,
          latestReadableRevision(
            context,
            `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(item.id)}/revisions`,
          ).then(async (latest) => {
            if (!latest) {
              return null;
            }
            const status = await context.request(
              `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(item.id)}/deployments/${encodeURIComponent(latest.id)}`,
            );
            return { revision: latest, status };
          }),
        );
      }
      void deployments
        .get(item.id)
        .then((result) => {
          if (!context.isCurrent()) {
            return;
          }
          if (result === null) {
            deployment.textContent = "No visible deployments";
            return;
          }
          deployment.replaceChildren(
            link(
              `v${result.revision.revision} · ${deploymentOutcome(result.status)}`,
              `agents/${item.id}?revision=${result.revision.id}`,
              context,
            ),
          );
          const neutral = neutralDeploymentOutcome(result.status);
          if (neutral) {
            deployment.append(
              element(
                "span",
                { className: "resource-id" },
                `${NEUTRAL_DEPLOYMENT_NOTES[neutral]}.`,
              ),
            );
          } else if (result.status.status === "failed") {
            deployment.append(
              element(
                "span",
                { className: "resource-id" },
                result.status.error?.message ?? "Deployment failed.",
              ),
            );
          }
          deployment.append(
            element("span", { className: "resource-id" }, "Serving health unverified"),
          );
        })
        .catch((error) => {
          deployment.textContent =
            error.status === 403 ? "Deployment access denied" : "Deployment unavailable";
        });
      body.append(
        element(
          "tr",
          {},
          element(
            "td",
            {},
            name,
            element("span", { className: "resource-id" }, item.id),
            item.status === "deleting" ? element("span", { className: "badge" }, "Deleting") : null,
            // New Agents start stopped; only a stop with a selected version awaits shutdown.
            item.status === "active" &&
              item.desiredRuntimeState === "stopped" &&
              item.activeRevisionId
              ? element("span", { className: "badge" }, "Stop requested")
              : null,
            item.configurationReadError
              ? element("span", { className: "badge" }, "Saved configuration unreadable")
              : null,
          ),
          element("td", {}, item.executionMode === "dedicated" ? "Dedicated" : "Embedded"),
          element(
            "td",
            {},
            item.activeRevisionId
              ? link(
                  shortId(item.activeRevisionId),
                  `agents/${item.id}?revision=${item.activeRevisionId}`,
                  context,
                )
              : "No current version",
          ),
          deployment,
          element("td", {}, displayDate(item.createdAt)),
          element(
            "td",
            {},
            element("div", { className: "agent-row-actions" }, actions.stop, actions.delete),
          ),
        ),
      );
    }
    table.append(body);
    rows.replaceChildren(element("div", { className: "table-scroll" }, table));
  }
  search.addEventListener("input", render);
  render();
}
