/**
 * Layout of one ticket's branch map. Pure: takes the ticket from the model and returns boxes and
 * paths in pixels, so it can be tested without a browser.
 *
 * Reading direction is left to right: a branch, the merge request leaving it, the branch it goes
 * into. Every repository is a lane; its destinations (release candidates, default branch) share
 * the rightmost column, so two branches pointing at different places visibly diverge.
 *
 * A branch whose merge request targets another branch of the ticket is drawn under that branch,
 * indented, with its merge request as an elbow going up into it. Indenting instead of adding a
 * column per level keeps a three-level stack inside a laptop window.
 */

export const G = {
  padX: 16,
  labelW: 196,
  /** In a window too narrow for the map, the repository column and the gap give way first. */
  labelWTight: 152,
  gapXTight: 138,
  nodeW: 304,
  /** How far a stacked branch is shifted right; its merge request label sits in this space. */
  indent: 120,
  gapX: 172,
  /** A wide window stretches the gap, up to this, instead of leaving the map in a corner. */
  gapMax: 320,
  trunkW: 188,
  nodeH: 54,
  nodeHChips: 80,
  nodeHCompact: 32,
  trunkH: 32,
  rowGap: 10,
  lanePadY: 14,
  groupH: 36,
};

/** Where along a merge request's curve its label sits, and where the "should point here" label sits. */
export const LABEL_T = { mr: 0.34, expected: 0.8 };

export const isLive = (item) => !item.mr || item.mr.state === 'opened';

/**
 * Short labels for the chips on a branch box; the full sentences live in the details.
 * `showVia` marks branches that belong to a parent ticket or a sub-task; it is off when every
 * branch on the map does, because then the mark says nothing.
 */
export function chipsOf(item, deployments = [], { showVia = true } = {}) {
  const chips = [];
  const has = (code) => item.flags.some((flag) => flag.code === code);
  if (has('target-missing')) chips.push({ level: 'error', text: 'cel usunięty' });
  if (has('conflict')) chips.push({ level: 'error', text: 'konflikt' });
  if (has('target-not-latest')) chips.push({ level: 'warn', text: 'nie najnowszy RC' });
  if (has('target-released')) chips.push({ level: 'warn', text: 'RC już wydany' });
  if (has('target-skips-rc') || has('target-skips-candidate')) chips.push({ level: 'warn', text: 'omija RC' });
  if (has('target-unexpected')) chips.push({ level: 'warn', text: 'zły cel' });
  if (has('base-differs')) chips.push({ level: 'warn', text: 'obce commity' });
  if (has('pipeline-failed')) chips.push({ level: 'warn', text: 'pipeline' });
  if (has('no-mr')) chips.push({ level: 'info', text: 'brak MR' });
  if (item.mr?.draft && item.mr.state === 'opened') chips.push({ level: 'info', text: 'draft' });
  if (item.mr?.state === 'opened' && item.mr.behindTarget > 0 && item.target?.exists) {
    chips.push({ level: 'info', text: `${item.mr.behindTarget} za celem` });
  }
  if (has('discussions')) chips.push({ level: 'info', text: 'wątki' });
  for (const deployment of deployments) {
    if (deployment.item !== item.key) continue;
    chips.push({
      level: 'env',
      text: deployment.upToDate === false ? `${envLabel(deployment.environment)}: starszy commit` : envLabel(deployment.environment),
    });
  }
  if (item.local) {
    if (item.local.state === 'local-only') chips.push({ level: 'info', text: 'tylko lokalnie' });
    else if (item.local.state === 'ahead' || item.local.state === 'diverged') chips.push({ level: 'info', text: `lokalnie +${item.local.ahead}` });
    else if (item.local.current) chips.push({ level: 'info', text: 'checkout' });
  }
  if (showVia && item.via.type !== 'own') chips.push({ level: 'via', text: `z #${item.via.number}` });
  return chips;
}

export const envLabel = (environment) => ({ stg: 'STG', preprod: 'preprod', uat: 'UAT' })[environment] ?? environment;

/** How a merge request's line is drawn. */
export function edgeStyle(item) {
  const mr = item.mr;
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed') return 'closed';
  const codes = new Set(item.flags.map((flag) => flag.code));
  if (codes.has('target-missing')) return 'error';
  for (const code of ['target-not-latest', 'target-released', 'target-skips-rc', 'target-skips-candidate', 'target-unexpected']) {
    if (codes.has(code)) return 'warn';
  }
  return mr.draft ? 'draft' : 'open';
}

/** A point on the cubic curve the edges are drawn with. */
export function curvePoint(from, to, t) {
  const dx = (to.x - from.x) / 2;
  const p = [from, { x: from.x + dx, y: from.y }, { x: to.x - dx, y: to.y }, to];
  const u = 1 - t;
  const weight = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: p.reduce((sum, point, index) => sum + point.x * weight[index], 0),
    y: p.reduce((sum, point, index) => sum + point.y * weight[index], 0),
  };
}

export function curvePath(from, to) {
  const dx = (to.x - from.x) / 2;
  return `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
}

/**
 * @param {{ groups: object[] }} ticket
 * @param {{ showFinished?: boolean, availableWidth?: number }} options
 */
export function layoutTicket(ticket, { showFinished = true, availableWidth = 0 } = {}) {
  const lanes = ticket.groups.flatMap((group) => group.lanes);
  const everyItem = lanes.flatMap((lane) => lane.items);
  const showVia = everyItem.some((item) => item.via.type === 'own') && everyItem.some((item) => item.via.type !== 'own');

  // Which items are drawn: with finished ones hidden, a finished branch stays only while
  // something unfinished is stacked on it.
  const visibleByLane = new Map();
  for (const lane of lanes) {
    const byKey = new Map(lane.items.map((item) => [item.key, item]));
    const keep = new Set(lane.items.filter((item) => showFinished || isLive(item)).map((item) => item.key));
    if (!showFinished) {
      for (const item of lane.items.filter(isLive)) {
        for (let parent = byKey.get(item.parentKey); parent; parent = byKey.get(parent.parentKey)) keep.add(parent.key);
      }
    }
    visibleByLane.set(lane.repo, lane.items.filter((item) => keep.has(item.key)));
  }

  const depthOf = (item, byKey, guard = 0) => {
    const parent = item.parentKey ? byKey.get(item.parentKey) : null;
    return parent && guard < 20 ? depthOf(parent, byKey, guard + 1) + 1 : 0;
  };
  let maxDepth = 0;
  for (const lane of lanes) {
    const items = visibleByLane.get(lane.repo);
    const byKey = new Map(items.map((item) => [item.key, item]));
    for (const item of items) maxDepth = Math.max(maxDepth, depthOf(item, byKey));
  }

  const widthWith = (labelW, gapX) => G.padX + labelW + G.nodeW + maxDepth * G.indent + gapX + G.trunkW + G.padX;
  const tight = availableWidth > 0 && widthWith(G.labelW, G.gapX) > availableWidth;
  const labelW = tight ? G.labelWTight : G.labelW;
  const nodeX = (depth) => G.padX + labelW + depth * G.indent;
  /** Right edge of the most indented branch: merge request lines towards the destinations start here. */
  const leadX = nodeX(maxDepth) + G.nodeW;
  const fixed = leadX + G.trunkW + G.padX;
  const gap = Math.round(Math.max(tight ? G.gapXTight : G.gapX, Math.min(G.gapMax, availableWidth - fixed)));
  const trunkX = leadX + gap;
  const width = trunkX + G.trunkW + G.padX;

  const layout = { width, height: 0, labelW, bands: [], nodes: [], trunks: [], edges: [], hidden: 0 };
  let y = 0;

  for (const group of ticket.groups) {
    layout.bands.push({ type: 'group', y, height: G.groupH, group });
    y += G.groupH;

    for (const lane of group.lanes) {
      const items = visibleByLane.get(lane.repo);
      layout.hidden += lane.items.length - items.length;
      const byKey = new Map(items.map((item) => [item.key, item]));
      const childrenOf = (key) => items.filter((item) => item.parentKey === key);
      const roots = items.filter((item) => !item.parentKey || !byKey.has(item.parentKey));

      // One row per branch, a branch's stack right under it.
      const rows = [];
      const seen = new Set();
      const place = (item, depth) => {
        if (seen.has(item.key)) return;
        seen.add(item.key);
        const chips = chipsOf(item, lane.deployments, { showVia });
        rows.push({ item, depth, chips, height: isLive(item) ? (chips.length ? G.nodeHChips : G.nodeH) : G.nodeHCompact });
        for (const child of childrenOf(item.key)) place(child, depth + 1);
      };
      for (const root of roots) place(root, 0);
      // Two branches targeting each other have no root; draw them anyway.
      for (const item of items) place(item, 0);

      const top = y + G.lanePadY;
      let rowY = top;
      const placed = new Map();
      for (const row of rows) {
        const node = {
          key: row.item.key,
          item: row.item,
          lane,
          chips: row.chips,
          compact: !isLive(row.item),
          depth: row.depth,
          x: nodeX(row.depth),
          y: rowY,
          width: G.nodeW,
          height: row.height,
          cy: rowY + row.height / 2,
        };
        placed.set(node.key, node);
        layout.nodes.push(node);
        rowY += row.height + G.rowGap;
      }
      const rowsBottom = rows.length ? rowY - G.rowGap : top;

      // Destinations, aligned so that the first one is level with the first row.
      let trunkY = top + Math.max(0, ((rows[0]?.height ?? G.trunkH) - G.trunkH) / 2);
      const trunkByRef = new Map();
      for (const trunk of lane.trunks) {
        const box = { trunk, lane, x: trunkX, y: trunkY, width: G.trunkW, height: G.trunkH, cy: trunkY + G.trunkH / 2 };
        trunkByRef.set(trunk.ref, box);
        layout.trunks.push(box);
        trunkY += G.trunkH + G.rowGap;
      }
      const trunksBottom = lane.trunks.length ? trunkY - G.rowGap : top;

      for (const node of placed.values()) {
        const { item } = node;
        const right = node.x + node.width;
        const parent = item.mr ? placed.get(item.parentKey) : null;
        const trunk = item.mr && !parent ? trunkByRef.get(item.mr.targetRef) : null;

        if (parent) {
          // Elbow: out of the left side, then up into the branch this one is stacked on.
          const turnX = parent.x + 18;
          const radius = 8;
          layout.edges.push({
            kind: 'mr',
            style: edgeStyle(item),
            item,
            path: `M${node.x},${node.cy} H${turnX + radius} Q${turnX},${node.cy} ${turnX},${node.cy - radius} V${parent.y + parent.height + 3}`,
            label: { x: (node.x + turnX) / 2 + 3, y: node.cy },
          });
        } else if (trunk) {
          const from = { x: leadX, y: node.cy };
          const to = { x: trunk.x - 2, y: trunk.cy };
          layout.edges.push({
            kind: 'mr',
            style: edgeStyle(item),
            item,
            path: `M${right},${node.cy} L${curvePath(from, to).slice(1)}`,
            // Beside its own branch when the straight run is long enough, otherwise on the curve.
            label: leadX - right >= 110 ? { x: right + 60, y: node.cy } : curvePoint(from, to, LABEL_T.mr),
          });
        }

        const expected = isLive(item) && item.expected && item.expected.reason !== 'stack' ? trunkByRef.get(item.expected.ref) : null;
        if (expected && item.expected.ref !== item.mr?.targetRef) {
          // Leave the box a little above or below the merge request's line, on the side the
          // expected destination lies, so the two lines part at once instead of overlapping.
          const side = trunk ? (expected.cy < trunk.cy ? -1 : 1) : 0;
          const from = { x: leadX, y: node.cy + side * 10 };
          const to = { x: expected.x - 2, y: expected.cy };
          layout.edges.push({
            kind: 'expected',
            style: 'expected',
            item,
            path: leadX > right ? `M${right},${node.cy} L${curvePath(from, to).slice(1)}` : curvePath(from, to),
            label: curvePoint(from, to, LABEL_T.expected),
          });
        }
      }

      const height = Math.max(rowsBottom, trunksBottom) - y + G.lanePadY;
      layout.bands.push({ type: 'lane', y, height, lane, group });
      y += height;
    }
  }

  layout.height = y;
  return layout;
}
