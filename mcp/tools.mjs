const emptyObjectSchema = { type: 'object', properties: {}, additionalProperties: false }
const blendModes = ['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY', 'PLUS_DARKER', 'PLUS_LIGHTER']
const rgbaSchema = {
  type: 'object',
  required: ['r', 'g', 'b', 'a'],
  properties: {
    r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' },
    a: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
}
const pointSchema = {
  type: 'object', required: ['x', 'y'],
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  additionalProperties: false,
}
const transformSchema = {
  type: 'array', minItems: 2, maxItems: 2,
  items: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
}
const imageFiltersSchema = {
  type: 'object',
  properties: Object.fromEntries(['contrast', 'exposure', 'highlights', 'saturation', 'shadows', 'temperature', 'tint', 'hue'].map(key => [key, { type: 'number', minimum: -1, maximum: 1 }])),
  additionalProperties: false,
}
const paintSchema = {
  type: 'object', required: ['type'],
  properties: {
    type: { type: 'string', enum: ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE', 'REFERENCE'] },
    isVisible: { type: 'boolean' },
    alpha: { type: 'number', minimum: 0, maximum: 1 },
    blendMode: { type: 'string', enum: blendModes },
    color: rgbaSchema,
    transform: transformSchema,
    gradientStops: {
      type: 'array',
      items: {
        type: 'object', required: ['position', 'color'],
        properties: { position: { type: 'number', minimum: 0, maximum: 1 }, color: rgbaSchema },
        additionalProperties: false,
      },
    },
    gradientHandlePositions: { type: 'array', items: pointSchema },
    imageRef: { type: 'string' },
    scaleMode: { type: 'string', enum: ['FILL', 'TILE', 'STRETCH', 'FIT', 'CROP'] },
    rotation: { type: 'number' },
    ratio: { type: 'number' },
    filters: imageFiltersSchema,
    reference: { type: 'string' },
    referenceSource: { type: 'string' },
    modeId: { type: 'string' },
  },
  additionalProperties: false,
}
const effectSchema = {
  type: 'object', required: ['type'],
  properties: {
    type: { type: 'string', enum: ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR', 'LIQUID_GLASS', 'REFERENCE'] },
    isVisible: { type: 'boolean' },
    radius: { type: 'number', minimum: 0, maximum: 10000 },
    spread: { type: 'number' },
    offset: pointSchema,
    color: rgbaSchema,
    blendMode: { type: 'string', enum: blendModes },
    gradient: {
      type: 'object', required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['EVEN', 'PROGRESSIVE'] },
        gradientStops: {
          type: 'array', items: {
            type: 'object', required: ['position', 'value'],
            properties: { position: { type: 'number', minimum: 0, maximum: 1 }, value: { type: 'number' } },
            additionalProperties: false,
          },
        },
        gradientHandlePositions: { type: 'array', minItems: 2, maxItems: 2, items: pointSchema },
        transform: transformSchema,
      },
      additionalProperties: false,
    },
    depth: { type: 'number' },
    dispersion: { type: 'number' },
    refraction: { type: 'number' },
    lightIntensity: { type: 'number' },
    lightAngle: { type: 'number' },
    reference: { type: 'string' },
    referenceSource: { type: 'string' },
    modeId: { type: 'string' },
  },
  additionalProperties: false,
}
const constraintsSchema = {
  type: 'object', required: ['horizontal', 'vertical'],
  properties: {
    horizontal: { type: 'string', enum: ['START', 'END', 'STARTANDEND', 'CENTER', 'SCALE'] },
    vertical: { type: 'string', enum: ['START', 'END', 'STARTANDEND', 'CENTER', 'SCALE'] },
  },
  additionalProperties: false,
}

export const tools = [
  {
    name: 'mastergo_status',
    description: 'Call this first for any MasterGo work. Read-only and fast. When connected it already returns the document, page, capabilities, and a bounded selection snapshot, so do not chain other read tools just to confirm the connection. Use actionRequired when disconnected.',
    inputSchema: {
      type: 'object',
      properties: {
        includeContext: {
          type: 'boolean',
          default: true,
          description: 'Set false to skip the document/selection probe and only report the connection state.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'mastergo_get_context',
    description: 'Re-read the active document summary plus a bounded selection snapshot in one call, after the user changes the selection or page. Read-only. Never returns the node tree.',
    inputSchema: {
      type: 'object',
      properties: {
        maxSelection: { type: 'integer', minimum: 1, maximum: 300, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'mastergo_get_node_tree',
    description: 'Read a bounded MasterGo node subtree. Requires an explicit nodeId from a previous read or a user-named layer; never fetch the whole page to look around. Read-only, limited by maxDepth/maxNodes.',
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string', minLength: 1 },
        maxDepth: { type: 'integer', minimum: 0, maximum: 6, default: 3 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 300, default: 120 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'mastergo_insert_svg',
    description: 'Insert a safe SVG as editable MasterGo vector nodes in the active page. Creates one undo boundary and returns the new node ID.',
    inputSchema: {
      type: 'object',
      required: ['name', 'svg'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        svg: { type: 'string', minLength: 5, maxLength: 200000 },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mastergo_render_html',
    description: 'Render HTML and CSS into editable MasterGo layers using QuickDesign existing HTML-to-design pipeline. Scripts are rejected. Returns created node IDs and warnings.',
    inputSchema: {
      type: 'object',
      required: ['html'],
      properties: {
        html: { type: 'string', minLength: 1, maxLength: 1000000 },
        viewportWidth: { type: 'integer', minimum: 320, maximum: 2560, default: 1440 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mastergo_create_design',
    description: 'Create an editable MasterGo design from a bounded declarative Design Spec containing frames, text, rectangles, ellipses, and SVG. No executable code is accepted.',
    inputSchema: {
      type: 'object',
      required: ['spec'],
      properties: { spec: { type: 'object' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mastergo_update_text',
    description: 'Replace text in one existing MasterGo text node. Pass expectedSignature from a recent read to prevent overwriting concurrent user changes.',
    inputSchema: {
      type: 'object',
      required: ['nodeId', 'text', 'expectedSignature'],
      properties: {
        nodeId: { type: 'string', minLength: 1 },
        text: { type: 'string', maxLength: 100000 },
        expectedSignature: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mastergo_update_nodes',
    description: 'Apply bounded visual/layout patches to existing MasterGo nodes. Only whitelisted properties are accepted; expectedSignature prevents stale writes. Signature includes parentId plus a fixed-size ordered child digest, so a reparent or child-structure change also invalidates a stale patch. Setters that the host rejects or node types do not support surface as per-node warnings.',
    inputSchema: {
      type: 'object',
      required: ['updates'],
      properties: {
        updates: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', required: ['nodeId', 'patch', 'expectedSignature'],
            properties: {
              nodeId: { type: 'string' },
              expectedSignature: { type: 'string' },
              patch: {
                type: 'object',
                properties: {
                  name: { type: 'string', maxLength: 120 },
                  x: { type: 'number' }, y: { type: 'number' },
                  width: { type: 'number', minimum: 1, maximum: 20000 },
                  height: { type: 'number', minimum: 1, maximum: 20000 },
                  opacity: { type: 'number', minimum: 0, maximum: 1 },
                  isVisible: { type: 'boolean' },
                  cornerRadius: { type: 'number', minimum: 0, maximum: 10000 },
                  fill: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$' },
                  fills: { type: 'array', maxItems: 32, items: paintSchema },
                  strokes: { type: 'array', maxItems: 32, items: paintSchema },
                  effects: { type: 'array', maxItems: 32, items: effectSchema },
                  rotation: { type: 'number' },
                  blendMode: { type: 'string', enum: blendModes },
                  layoutPositioning: { type: 'string', enum: ['AUTO', 'ABSOLUTE'] },
                  constraints: constraintsSchema,
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mastergo_node_op',
    description: 'General node-operation dispatcher exposing MasterGo structural primitives so you can compose manipulations yourself. Set action to one of: delete (remove nodeIds; captures identity before removal), move (reparent nodeId into parentId and/or reorder to index; preserveAbsolute defaults true), reorder (nodeId to front|back|numeric index within its parent; anything else is rejected), duplicate (clone nodeIds; optional name/dx/dy offset), group (mg.group of nodeIds), ungroup (hoist a GROUP/FRAME wrapper’s children back into its parent then remove the wrapper — MasterGo has no native ungroup; pass nodeIds or groupId; failed steps roll children back into the wrapper), create_shape (shape=rectangle|ellipse|line|polygon|star|frame with x/y/width/height/fills/parentId), boolean (booleanOp=union|subtract|intersect|exclude over nodeIds). To flatten redundant empty DIV/SPAN wrapper shells, compose ungroup (or move leaves up then delete the wrapper) instead of a dedicated tool. Every action creates one MasterGo undo boundary (Cmd+Z). Destructive actions are stale-write guarded and there is no bypass: move/reorder require expectedSignature for nodeId, and delete/ungroup/group/boolean require an expectedSignatures:[{nodeId,signature}] entry for every target. Signatures include parentId and a fixed-size ordered child digest, so structural edits (reparenting, child reorder/add/remove) invalidate stale writes.',
    inputSchema: {
      type: 'object', required: ['action'],
      properties: {
        action: { type: 'string', enum: ['delete', 'move', 'reorder', 'duplicate', 'group', 'ungroup', 'create_shape', 'boolean'] },
        nodeIds: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string' }, description: 'Target node IDs for batch actions: delete/duplicate/group/boolean/ungroup.' },
        nodeId: { type: 'string', minLength: 1, description: 'Single target node for move/reorder.' },
        groupId: { type: 'string', minLength: 1, description: 'Single wrapper to dissolve for ungroup.' },
        parentId: { type: 'string', description: 'Destination container for move, or the parent to place a created shape into.' },
        index: { type: 'integer', minimum: 0, description: 'Insertion index within destination parent for move.' },
        to: { type: 'string', description: "Z-order target for reorder: 'front', 'back', or a non-negative integer string. Anything else returns INVALID_ARGUMENT." },
        preserveAbsolute: { type: 'boolean', default: true, description: 'For move: keep the node’s absolute on-canvas position across reparenting.' },
        shape: { type: 'string', enum: ['rectangle', 'ellipse', 'line', 'polygon', 'star', 'frame'], description: 'Primitive to create for create_shape.' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        dx: { type: 'number', description: 'X offset applied to each duplicate.' },
        dy: { type: 'number', description: 'Y offset applied to each duplicate.' },
        fill: { type: 'string', description: 'Hex fill for a created shape, e.g. #FF0000.' },
        fills: { type: 'array', items: { type: 'object' }, description: 'Full fills array for a created shape.' },
        cornerRadius: { type: 'number' },
        opacity: { type: 'number' },
        isVisible: { type: 'boolean' },
        name: { type: 'string', description: 'New/renamed node label.' },
        booleanOp: { type: 'string', enum: ['union', 'subtract', 'intersect', 'exclude'], description: 'Boolean operation for action=boolean.' },
        expectedSignature: { type: 'string', description: 'Mandatory signature of the single nodeId for move/reorder; read it from a fresh get_node_tree/status call. No unsigned bypass.' },
        expectedSignatures: { type: 'array', items: { type: 'object', required: ['nodeId', 'signature'], properties: { nodeId: { type: 'string' }, signature: { type: 'string' } } }, description: 'Mandatory per-node signatures for destructive batch actions: delete/ungroup/group/boolean. One entry per target id, no bypass.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'mastergo_zoom_to_nodes',
    description: 'Select and zoom the MasterGo viewport to one or more node IDs. Changes selection/viewport only; does not change node content.',
    inputSchema: {
      type: 'object', required: ['nodeIds'],
      properties: { nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mastergo_undo',
    description: 'Trigger one MasterGo undo operation. This changes the active document and may undo the user most recent action if another action occurred after the agent write.',
    inputSchema: emptyObjectSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]

export const toolMethods = {
  mastergo_get_context: 'session.context',
  mastergo_get_node_tree: 'nodes.tree',
  mastergo_insert_svg: 'design.insertSvg',
  mastergo_render_html: 'design.renderHtml',
  mastergo_create_design: 'design.create',
  mastergo_update_text: 'nodes.updateText',
  mastergo_update_nodes: 'nodes.update',
  mastergo_node_op: 'nodes.op',
  mastergo_zoom_to_nodes: 'viewport.zoomTo',
  mastergo_undo: 'history.undo',
}
