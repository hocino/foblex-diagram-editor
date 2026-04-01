import { Component, signal, computed, WritableSignal, viewChild, effect, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  FFlowModule,
  FZoomDirective,
  FFlowComponent,
  FCreateConnectionEvent,
  FSelectionChangeEvent,
} from '@foblex/flow';
import { IPoint } from '@foblex/2d';
import ELK from 'elkjs/lib/elk.bundled.js';

// ─── Serializable diagram format ──────────────────────────────────────────────
export interface DiagramData {
  version: '1.0';
  nodes: Array<{
    id: string;
    label: string;
    type: ShapeType;
    position: IPoint;
    color: string;
    groupId: string | null;
    businessData?: BusinessObjectData;
  }>;
  groups: Array<{
    id: string;
    label: string;
    position: IPoint;
    color: string;
  }>;
  connections: Array<{ id: string; sourceId: string; targetId: string }>;
}

const LS_KEY = 'foblex-diagram';

export type ShapeType = 'rectangle' | 'circle' | 'diamond' | 'process' | 'business-object';

export interface BusinessObjectData {
  title: string;
  flow: string;
  duration: string;
  calendar: string;
  code: string;
  effort: number;
  locked: boolean;
}

export interface NodeDef {
  id: string;
  label: string;
  type: ShapeType;
  position: WritableSignal<IPoint>;
  color: WritableSignal<string>;
  groupId: WritableSignal<string | undefined>;
  businessData: WritableSignal<BusinessObjectData | undefined>;
}

export interface GroupDef {
  id: string;
  label: WritableSignal<string>;
  position: WritableSignal<IPoint>;
  color: WritableSignal<string>;
}

export interface ConnectionDef {
  id: string;
  sourceId: string;
  targetId: string;
}

const SHAPE_COLORS: Record<ShapeType, string> = {
  rectangle: '#F47A30',
  circle: '#F47A30',
  diamond: '#F47A30',
  process: '#F47A30',
  'business-object': '#F26722',
};

export type ElkAlgorithm = 'layered' | 'mrtree' | 'radial' | 'force' | 'box';

export const ELK_ALGORITHMS: { value: ElkAlgorithm; label: string }[] = [
  { value: 'layered',  label: 'Hiérarchique (Layered)' },
  { value: 'mrtree',  label: 'Arbre (Tree)' },
  { value: 'radial',  label: 'Radial' },
  { value: 'force',   label: 'Force dirigée' },
  { value: 'box',     label: 'Boîtes (Box)' },
];

const SHAPE_LABELS: Record<ShapeType, string> = {
  rectangle: 'Rectangle',
  circle: 'Cercle',
  diamond: 'Losange',
  process: 'Processus',
  'business-object': 'Activité',
};

const DEFAULT_BUSINESS_OBJECT = (index: number): BusinessObjectData => ({
  title: `Activité ${index}`,
  flow: 'Flow 6 : CT CND',
  duration: '50h',
  calendar: '-',
  code: 'DRT',
  effort: 22,
  locked: true,
});

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, FFlowModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class AppComponent {
  readonly flowRef = viewChild<FFlowComponent>('flow');
  readonly zoomRef = viewChild<FZoomDirective>('zoom');
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  elkAlgorithm = signal<ElkAlgorithm>('layered');
  elkAlgorithms = ELK_ALGORITHMS;
  elkLayoutRunning = signal(false);

  nodes = signal<NodeDef[]>([]);
  groups = signal<GroupDef[]>([]);
  connections = signal<ConnectionDef[]>([]);

  toast = signal<string | null>(null);
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  selectedNodeIds = signal<string[]>([]);
  selectedGroupIds = signal<string[]>([]);
  selectedConnectionIds = signal<string[]>([]);

  editingNode = computed<NodeDef | null>(() => {
    const ids = this.selectedNodeIds();
    if (ids.length === 1) {
      return this.nodes().find((n) => n.id === ids[0]) ?? null;
    }
    return null;
  });

  editingGroup = computed<GroupDef | null>(() => {
    const ids = this.selectedGroupIds();
    if (ids.length === 1 && this.selectedNodeIds().length === 0) {
      return this.groups().find((g) => g.id === ids[0]) ?? null;
    }
    return null;
  });

  private _nodeCounter = 0;
  private _groupCounter = 0;
  private _connectionCounter = 0;

  constructor() {
    // Auto-load last session from localStorage
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      try {
        this._restoreState(JSON.parse(saved));
      } catch { /* ignore corrupt data */ }
    }

    // Auto-save to localStorage on every state change
    effect(() => {
      localStorage.setItem(LS_KEY, JSON.stringify(this._serialize()));
    });
  }

  // ─── Shape Actions ────────────────────────────────────────────────────────

  addNode(type: ShapeType): void {
    this._nodeCounter++;
    const id = `node-${this._nodeCounter}`;
    const businessData = type === 'business-object'
      ? DEFAULT_BUSINESS_OBJECT(this._nodeCounter)
      : undefined;

    this.nodes.update((nodes) => [
      ...nodes,
      {
        id,
        label: businessData?.title ?? `${SHAPE_LABELS[type]} ${this._nodeCounter}`,
        type,
        position: signal<IPoint>({ x: 80 + Math.random() * 500, y: 80 + Math.random() * 350 }),
        color: signal(SHAPE_COLORS[type]),
        groupId: signal(undefined),
        businessData: signal(businessData),
      },
    ]);
  }

  updateNodeLabel(node: NodeDef, label: string): void {
    this.nodes.update((nodes) =>
      nodes.map((n) => (n.id === node.id ? { ...n, label } : n))
    );
  }

  updateNodeColor(node: NodeDef, color: string): void {
    node.color.set(color);
  }

  updateBusinessObject(node: NodeDef, patch: Partial<BusinessObjectData>): void {
    const current = node.businessData();
    if (!current) return;

    const next = { ...current, ...patch };
    node.businessData.set(next);
    if (patch.title !== undefined) {
      this.updateNodeLabel(node, patch.title);
    }
  }

  updateGroupLabel(group: GroupDef, label: string): void {
    group.label.set(label);
  }

  updateGroupColor(group: GroupDef, color: string): void {
    group.color.set(color);
  }

  // ─── Group Actions ────────────────────────────────────────────────────────

  groupSelected(): void {
    const selNodeIds = this.selectedNodeIds();
    if (selNodeIds.length < 2) return;

    this._groupCounter++;
    const groupId = `group-${this._groupCounter}`;

    const selectedNodes = this.nodes().filter((n) => selNodeIds.includes(n.id));
    const positions = selectedNodes.map((n) => n.position());
    const minX = Math.min(...positions.map((p) => p.x)) - 24;
    const minY = Math.min(...positions.map((p) => p.y)) - 48;

    this.groups.update((groups) => [
      ...groups,
      {
        id: groupId,
        label: signal(`Groupe ${this._groupCounter}`),
        position: signal<IPoint>({ x: minX, y: minY }),
        color: signal('#F47A30'),
      },
    ]);

    this.nodes.update((nodes) =>
      nodes.map((n) => {
        if (selNodeIds.includes(n.id)) {
          const abs = n.position();
          n.position.set({ x: abs.x - minX, y: abs.y - minY });
          n.groupId.set(groupId);
        }
        return n;
      })
    );

    this.selectedNodeIds.set([]);
    this.selectedGroupIds.set([groupId]);
  }

  ungroupSelected(): void {
    const selGroupIds = this.selectedGroupIds();
    if (selGroupIds.length === 0) return;

    selGroupIds.forEach((groupId) => {
      const group = this.groups().find((g) => g.id === groupId);
      if (!group) return;
      const groupPos = group.position();
      this.nodes.update((nodes) =>
        nodes.map((n) => {
          if (n.groupId() === groupId) {
            const rel = n.position();
            n.position.set({ x: groupPos.x + rel.x, y: groupPos.y + rel.y });
            n.groupId.set(undefined);
          }
          return n;
        })
      );
    });

    this.groups.update((groups) => groups.filter((g) => !selGroupIds.includes(g.id)));
    this.selectedGroupIds.set([]);
  }

  // ─── Delete Action ────────────────────────────────────────────────────────

  deleteSelected(): void {
    const selNodeIds = this.selectedNodeIds();
    const selGroupIds = this.selectedGroupIds();
    const selConnIds = this.selectedConnectionIds();

    if (selNodeIds.length > 0) {
      this.connections.update((conns) =>
        conns.filter((c) => {
          const src = c.sourceId.replace('-output', '');
          const tgt = c.targetId.replace('-input', '');
          return !selNodeIds.includes(src) && !selNodeIds.includes(tgt);
        })
      );
      this.nodes.update((nodes) => nodes.filter((n) => !selNodeIds.includes(n.id)));
    }

    if (selConnIds.length > 0) {
      this.connections.update((conns) => conns.filter((c) => !selConnIds.includes(c.id)));
    }

    if (selGroupIds.length > 0) {
      this.nodes.update((nodes) =>
        nodes.map((n) => {
          if (selGroupIds.includes(n.groupId() ?? '')) {
            n.groupId.set(undefined);
          }
          return n;
        })
      );
      this.groups.update((groups) => groups.filter((g) => !selGroupIds.includes(g.id)));
    }

    this.selectedNodeIds.set([]);
    this.selectedGroupIds.set([]);
    this.selectedConnectionIds.set([]);
  }

  // ─── Connection Events ────────────────────────────────────────────────────

  onCreateConnection(event: FCreateConnectionEvent): void {
    if (!event.targetId) return;
    const alreadyExists = this.connections().some(
      (c) => c.sourceId === event.sourceId && c.targetId === event.targetId
    );
    if (alreadyExists) return;

    this._connectionCounter++;
    this.connections.update((conns) => [
      ...conns,
      {
        id: `conn-${this._connectionCounter}`,
        sourceId: event.sourceId,
        targetId: event.targetId!,
      },
    ]);
  }

  // ─── Selection Events ─────────────────────────────────────────────────────

  onSelectionChange(event: FSelectionChangeEvent): void {
    this.selectedNodeIds.set(event.nodeIds);
    this.selectedGroupIds.set(event.groupIds);
    this.selectedConnectionIds.set(event.connectionIds);
  }

  // ─── Zoom Actions ─────────────────────────────────────────────────────────

  zoomIn(): void {
    this.zoomRef()?.zoomIn();
  }

  zoomOut(): void {
    this.zoomRef()?.zoomOut();
  }

  resetZoom(): void {
    this.zoomRef()?.reset();
  }

  // ─── Save / Load ──────────────────────────────────────────────────────────

  newDiagram(): void {
    if (this.nodes().length > 0 || this.groups().length > 0) {
      if (!confirm('Créer un nouveau diagramme ? Les modifications non sauvegardées seront perdues.')) return;
    }
    this.nodes.set([]);
    this.groups.set([]);
    this.connections.set([]);
    this.selectedNodeIds.set([]);
    this.selectedGroupIds.set([]);
    this.selectedConnectionIds.set([]);
    this._nodeCounter = 0;
    this._groupCounter = 0;
    this._connectionCounter = 0;
    localStorage.removeItem(LS_KEY);
  }

  saveDiagram(): void {
    const data = this._serialize();
    // Persist in localStorage
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    // Download as file
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagram-${new Date().toISOString().slice(0, 19).replaceAll(/[:T]/g, '-')}.foblex.json`;
    a.click();
    URL.revokeObjectURL(url);
    this._showToast('Diagramme sauvegardé !');
  }

  loadDiagram(): void {
    this.fileInput()?.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.text()
      .then((content) => {
        const data: DiagramData = JSON.parse(content);
        if (data.version !== '1.0' || !Array.isArray(data.nodes)) {
          this._showToast('Fichier invalide.');
          return;
        }
        this._restoreState(data);
        localStorage.setItem(LS_KEY, JSON.stringify(data));
        this._showToast('Diagramme chargé !');
      })
      .catch(() => {
        this._showToast('Erreur de lecture du fichier.');
      })
      .finally(() => {
        (event.target as HTMLInputElement).value = '';
      });
  }

  private _serialize(): DiagramData {
    return {
      version: '1.0',
      nodes: this.nodes().map((n) => ({
        id: n.id,
        label: n.label,
        type: n.type,
        position: n.position(),
        color: n.color(),
        groupId: n.groupId() ?? null,
        businessData: n.businessData(),
      })),
      groups: this.groups().map((g) => ({
        id: g.id,
        label: g.label(),
        position: g.position(),
        color: g.color(),
      })),
      connections: this.connections().map((c) => ({ ...c })),
    };
  }

  private _restoreState(data: DiagramData): void {
    const maxId = (prefix: string, ids: string[]) =>
      ids.reduce((max, id) => Math.max(max, Number.parseInt(id.replace(prefix, ''), 10) || 0), 0);

    this._nodeCounter = maxId('node-', data.nodes.map((n) => n.id));
    this._groupCounter = maxId('group-', data.groups.map((g) => g.id));
    this._connectionCounter = maxId('conn-', data.connections.map((c) => c.id));

    this.nodes.set(
      data.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        type: n.type,
        position: signal<IPoint>(n.position),
        color: signal(n.color),
        groupId: signal(n.groupId ?? undefined),
        businessData: signal(
          n.type === 'business-object'
            ? {
                ...DEFAULT_BUSINESS_OBJECT(Number.parseInt(n.id.replace('node-', ''), 10) || 1),
                ...n.businessData,
                title: n.businessData?.title ?? n.label,
              }
            : undefined
        ),
      }))
    );
    this.groups.set(
      data.groups.map((g) => ({
        id: g.id,
        label: signal(g.label),
        position: signal<IPoint>(g.position),
        color: signal(g.color),
      }))
    );
    this.connections.set(data.connections.map((c) => ({ ...c })));
    this.selectedNodeIds.set([]);
    this.selectedGroupIds.set([]);
    this.selectedConnectionIds.set([]);
  }

  private _showToast(msg: string): void {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this.toast.set(msg);
    this._toastTimer = setTimeout(() => this.toast.set(null), 2500);
  }

  // ─── ELK Auto-layout ─────────────────────────────────────────────────────

  autoLayout(): void {
    if (this.elkLayoutRunning()) return;

    const ungroupedNodes = this.nodes().filter((n) => !n.groupId());
    if (ungroupedNodes.length === 0) return;

    const algorithm = this.elkAlgorithm();
    const conns = this.connections();
    const nodeIds = new Set(ungroupedNodes.map((n) => n.id));

    // Build ELK graph
    const elkGraph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': algorithm,
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'elk.spacing.nodeNode': '60',
        'elk.padding': '[top=60,left=60,bottom=60,right=60]',
        'elk.direction': algorithm === 'layered' ? 'RIGHT' : 'DOWN',
      },
      children: ungroupedNodes.map((n) => ({
        id: n.id,
        width: n.type === 'business-object' ? 264 : 160,
        height: n.type === 'business-object' ? 128 : 60,
      })),
      edges: conns
        .filter((c) => {
          const src = c.sourceId.replace('-output', '');
          const tgt = c.targetId.replace('-input', '');
          return nodeIds.has(src) && nodeIds.has(tgt);
        })
        .map((c) => ({
          id: c.id,
          sources: [c.sourceId.replace('-output', '')],
          targets: [c.targetId.replace('-input', '')],
        })),
    };

    this.elkLayoutRunning.set(true);
    const elk = new ELK();
    elk.layout(elkGraph).then((result) => {
      result.children?.forEach((elkNode) => {
        const node = ungroupedNodes.find((n) => n.id === elkNode.id);
        if (node && elkNode.x != null && elkNode.y != null) {
          node.position.set({ x: elkNode.x, y: elkNode.y });
        }
      });
      setTimeout(() => {
        this.flowRef()?.redraw();
        this.zoomRef()?.reset();
      }, 50);
      this._showToast('Disposition ELK appliquée !');
    }).catch(() => {
      this._showToast('Erreur lors du calcul de disposition.');
    }).finally(() => {
      this.elkLayoutRunning.set(false);
      elk.terminateWorker();
    });
  }

  // ─── Computed helpers ─────────────────────────────────────────────────────

  hasSelection(): boolean {
    return (
      this.selectedNodeIds().length > 0 ||
      this.selectedGroupIds().length > 0 ||
      this.selectedConnectionIds().length > 0
    );
  }

  canGroup(): boolean {
    return this.selectedNodeIds().length >= 2 && this.selectedGroupIds().length === 0;
  }

  canUngroup(): boolean {
    return this.selectedGroupIds().length > 0 && this.selectedNodeIds().length === 0;
  }
}
