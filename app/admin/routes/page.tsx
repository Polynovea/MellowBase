"use client";

import { useState, useEffect, useRef } from "react";
import AdminLayout from "@/components/admin/AdminLayout";
import { useDialogKeyboard } from "@/components/admin/useDialogKeyboard";

/** An entry the route can point to: its title (or name), else its short ID. */
type EntryChoice = { id: string; label: string };
import {
  GitFork,
  Plus,
  Globe,
  FolderTree,
  ExternalLink,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Edit2,
  CornerUpRight,
  Search,
} from "lucide-react";

interface RouteNode {
  id: string;
  parent_route_id: string | null;
  entry_id: string | null;
  locale: string;
  path: string;
  title: string | null;
  node_type: "routable_entry" | "virtual_folder" | "external_link" | "custom_path";
  is_canonical: boolean;
  status: "active" | "draft" | "archived";
  order_index: number;
  children?: RouteNode[];
}

export default function RoutesPage() {
  const [routesTree, setRoutesTree] = useState<RouteNode[]>([]);
  const [locale, setLocale] = useState("en");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Register Route Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newNodeType, setNewNodeType] = useState<"routable_entry" | "virtual_folder" | "external_link" | "custom_path">("routable_entry");
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [collisionWarning, setCollisionWarning] = useState<string | null>(null);
  // A routable entry's route must name its entry: publishing and releases check for "an active
  // canonical route" of that entry. The form had no way to choose one, so that check could never pass.
  const [entries, setEntries] = useState<EntryChoice[]>([]);
  const [newEntryId, setNewEntryId] = useState("");
  const createRef = useRef<HTMLDivElement>(null);
  useDialogKeyboard(createRef, showCreateModal, () => setShowCreateModal(false));

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/entries");
        const body = await res.json();
        if (!res.ok) return;
        setEntries((body.data || []).map((entry: { id: string; data?: Record<string, unknown> }) => {
          const title = [entry.data?.title, entry.data?.name].find((value): value is string => typeof value === "string" && value.trim() !== "");
          return { id: entry.id, label: title ? title.trim() : `entry:${entry.id.slice(0, 8)}` };
        }));
      } catch {
        // The form still works for folders and custom paths.
      }
    })();
  }, []);

  // Arriving from a "no canonical route" readiness finding (?entry=<id>): open the form for that entry.
  // (Read from the address directly: useSearchParams would need a Suspense boundary on this static page.)
  useEffect(() => {
    const entry = new URLSearchParams(window.location.search).get("entry");
    if (!entry) return;
    setNewEntryId(entry);
    setNewNodeType("routable_entry");
    setNewParentId(null);
    setNewPath("/");
    setShowCreateModal(true);
  }, []);

  // Edit Route Modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingRoute, setEditingRoute] = useState<RouteNode | null>(null);
  const [editPath, setEditPath] = useState("");
  const [editTitle, setEditTitle] = useState("");

  useEffect(() => {
    loadTree();
  }, [locale]);

  async function loadTree() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/routes/tree?locale=${locale}`);
      const json = await res.json();
      if (json.success) {
        setRoutesTree(json.data || []);
      } else {
        setError(json.error || "Could not load site tree");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function checkCollision(path: string) {
    if (!path.trim()) {
      setCollisionWarning(null);
      return;
    }
    try {
      const res = await fetch("/api/routes/collision-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, locale }),
      });
      const json = await res.json();
      if (json.success && json.data.isCollision) {
        setCollisionWarning(`Collision: '${json.data.normalizedPath}' is already in use`);
      } else {
        setCollisionWarning(null);
      }
    } catch {
      // ignore
    }
  }

  async function handleCreateRoute(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: newPath,
          title: newTitle,
          locale,
          nodeType: newNodeType,
          parentRouteId: newParentId,
          entryId: newNodeType === "routable_entry" && newEntryId ? newEntryId : undefined,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setSuccess(`Route '${json.data.path}' registered successfully.`);
        setShowCreateModal(false);
        setNewPath("");
        setNewTitle("");
        setNewParentId(null);
        setNewEntryId("");
        loadTree();
      } else {
        setError(json.error);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleUpdateRoute(e: React.FormEvent) {
    e.preventDefault();
    if (!editingRoute) return;
    try {
      const res = await fetch(`/api/routes/${editingRoute.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: editPath,
          title: editTitle,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setSuccess(
          `Route updated to '${json.data.route.path}'. ${
            json.data.redirectCreated ? "Automatic 301 redirect created." : ""
          }`
        );
        setShowEditModal(false);
        setEditingRoute(null);
        loadTree();
      } else {
        setError(json.error);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  function renderRouteNode(node: RouteNode, depth = 0) {
    return (
      <div key={node.id} className="border-b border-subtle last:border-0">
        <div
          className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
          style={{ paddingLeft: `${depth * 24 + 16}px` }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {depth > 0 && <span className="text-fg-muted text-xs">└─</span>}
            <span className="font-mono text-sm font-semibold text-primary">{node.path}</span>
            {node.title && <span className="truncate text-xs font-medium text-fg-secondary">({node.title})</span>}
            {node.node_type === "virtual_folder" && (
              <span className="text-[10px] bg-review-muted text-review border border-review px-1.5 py-0.5 rounded uppercase font-semibold">
                Folder
              </span>
            )}
            {node.is_canonical && (
              <span className="text-[10px] bg-success-muted text-success border border-success px-1.5 py-0.5 rounded uppercase font-semibold">
                Canonical
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setNewParentId(node.id);
                setNewPath(`${node.path}/`);
                setShowCreateModal(true);
              }}
              className="ui-btn ui-btn-secondary min-h-0 px-2.5 py-1.5 text-[11px]"
            >
              <Plus className="w-3 h-3" /> Child Route
            </button>
            <button
              onClick={() => {
                setEditingRoute(node);
                setEditPath(node.path);
                setEditTitle(node.title || "");
                setShowEditModal(true);
              }}
              className="ui-btn ui-btn-secondary min-h-0 px-2.5 py-1.5 text-[11px]"
            >
              <Edit2 className="w-3 h-3" /> Edit Path
            </button>
          </div>
        </div>
        {node.children && node.children.map((child) => renderRouteNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <AdminLayout>
      <div className="ui-page mx-auto max-w-7xl">
        {/* Header */}
        <div className="ui-page-header">
          <div>
            <p className="ui-eyebrow">Structure / Routing</p>
            <h1 className="ui-page-title flex items-center gap-2">
              <GitFork className="h-5 w-5 text-primary" />
              Site Tree & Route Registry
            </h1>
            <p className="ui-page-description">
              Govern canonical routes, URL path hierarchies, collision detection, and automated 301 redirects.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              aria-label="Locale"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              className="min-w-44 rounded-lg px-3 py-2 text-sm"
            >
              <option value="en">Locale: en (English)</option>
              <option value="fr">Locale: fr (French)</option>
              <option value="es">Locale: es (Spanish)</option>
              <option value="de">Locale: de (German)</option>
            </select>
            <button
              onClick={() => {
                setNewParentId(null);
                setNewPath("/");
                setShowCreateModal(true);
              }}
              className="ui-btn ui-btn-primary"
            >
              <Plus className="w-4 h-4" />
              Register Route
            </button>
          </div>
        </div>

        {/* Alerts */}
        {error && (
          <div className="ui-alert ui-alert-danger mt-5 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}
        {success && (
          <div className="ui-alert ui-alert-success mt-5 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {success}
          </div>
        )}

        {/* Main Tree View */}
        <div className="mt-6 overflow-hidden border-y border-subtle">
          <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
            <span className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">
              Managed Path Hierarchy ({locale})
            </span>
            <span className="font-mono text-[10px] text-fg-muted">{routesTree.length} root routes</span>
          </div>
          {routesTree.length === 0 ? (
            <div className="ui-empty">
              No routes registered for locale '{locale}'. Click "Register Route" to create canonical paths.
            </div>
          ) : (
            <div>{routesTree.map((root) => renderRouteNode(root))}</div>
          )}
        </div>

        {/* Register Route Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div ref={createRef} role="dialog" aria-modal="true" aria-labelledby="register-route-title" className="ui-card-elevated max-w-md w-full p-6 space-y-4">
              <h2 id="register-route-title" className="text-lg font-bold text-fg-primary">Register Canonical Route</h2>
              <form onSubmit={handleCreateRoute} className="space-y-4">
                <div>
                  <label htmlFor="route-path" className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Path</label>
                  <input
                    id="route-path"
                    type="text"
                    required
                    value={newPath}
                    onChange={(e) => {
                      setNewPath(e.target.value);
                      checkCollision(e.target.value);
                    }}
                    placeholder="/products/shoes"
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm font-mono"
                  />
                  {collisionWarning && (
                    <p className="text-xs text-warning mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {collisionWarning}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="route-title" className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Page Title / Label</label>
                  <input
                    id="route-title"
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Footwear Catalog"
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="route-node-type" className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Node Type</label>
                  <select
                    id="route-node-type"
                    value={newNodeType}
                    onChange={(e: any) => setNewNodeType(e.target.value)}
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="routable_entry">Routable Entry</option>
                    <option value="virtual_folder">Virtual Folder (Structural)</option>
                    <option value="custom_path">Custom Path</option>
                    <option value="external_link">External Link</option>
                  </select>
                </div>
                {newNodeType === "routable_entry" && (
                  <div>
                    <label htmlFor="route-entry" className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Entry</label>
                    <select
                      id="route-entry"
                      required
                      value={newEntryId}
                      onChange={(e) => setNewEntryId(e.target.value)}
                      aria-describedby="route-entry-hint"
                      className="mt-1 w-full rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Choose the entry this address shows…</option>
                      {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </select>
                    <p id="route-entry-hint" className="mt-1 text-xs text-fg-muted">This becomes the entry&apos;s main (canonical) address, which publishing and releases need.</p>
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="ui-btn ui-btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={Boolean(collisionWarning)}
                    className="ui-btn ui-btn-primary"
                  >
                    Register
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Route Modal */}
        {showEditModal && editingRoute && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="ui-card-elevated max-w-md w-full p-6 space-y-4">
              <h3 className="text-lg font-bold text-fg-primary flex items-center gap-2">
                <CornerUpRight className="w-5 h-5 text-primary" />
                Update Route Path
              </h3>
              <p className="text-xs text-fg-muted">
                Changing a path automatically records route history and creates a 301 permanent redirect from{" "}
                <code className="font-mono text-primary">{editingRoute.path}</code> to the new path.
              </p>
              <form onSubmit={handleUpdateRoute} className="space-y-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">New Path</label>
                  <input
                    type="text"
                    required
                    value={editPath}
                    onChange={(e) => setEditPath(e.target.value)}
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Title</label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowEditModal(false)}
                    className="ui-btn ui-btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="ui-btn ui-btn-primary"
                  >
                    Save & Create 301 Redirect
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
