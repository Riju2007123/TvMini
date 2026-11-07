/**
 * Macromedia Flash Professional 8 — Shape Model (Half-Edge Planar Map)
 *
 * Implements the authoring topological shape model from `docs/shape-model-from-api.md`:
 *
 *   Shape   = contours[] + edges[] + vertices[] + styles[]
 *   Contour = closed half-edge loop; interior (bool) + orientation (+1 / -1)
 *   HalfEdge= getNext() / getPrev() + getOppositeHalfEdge() + getEdge() + getVertex()
 *   Edge    = up to 2 half-edges, N Bézier control points, isLine, splitEdge(t)
 *   Vertex  = point, x/y in stage space and 16.16 fixed-point (FUN_00f2afd0)
 *
 * Authoring Builders:
 * - Path object: newPath() -> newContour() -> addPoint/addCurve/addCubicCurve -> close() -> makeShape()
 * - DrawingLayer: beginDraw() -> moveTo/lineTo/curveTo/cubicCurveTo -> endDraw()
 * - dumpJSFL(): dumps topology compatible with `probes/probe-dump.jsfl` and `brush-smooth50.json`.
 */

import { toFixed16, fromFixed16 } from "./flash8-drawing.js";
import { strokeOutline, strokeRadii } from "./paint.js";

let nextId = 1;

export class Vertex {
  constructor(x, y) {
    this.id = nextId++;
    this.x = Number(x);
    this.y = Number(y);
    this.fixedX = toFixed16(this.x);
    this.fixedY = toFixed16(this.y);
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
    };
  }
}

export class HalfEdge {
  constructor(vertex, edge = null) {
    this.id = nextId++;
    this.vertex = vertex; // The vertex this half-edge starts at
    this.edge = edge; // The undirected edge
    this.next = null;
    this.prev = null;
    this.opposite = null; // Twin half-edge if shared
    this.contour = null;
  }

  getNext() {
    return this.next;
  }

  getPrev() {
    return this.prev;
  }

  getOppositeHalfEdge() {
    return this.opposite;
  }

  getEdge() {
    return this.edge;
  }

  getVertex() {
    return this.vertex;
  }

  toJSON() {
    return {
      id: this.id,
      vertexId: this.vertex?.id,
      edgeId: this.edge?.id,
      nextId: this.next?.id,
      prevId: this.prev?.id,
      oppositeId: this.opposite?.id,
    };
  }
}

export class Edge {
  constructor(v0, v1, isLine = true, controlPoints = []) {
    this.id = nextId++;
    this.v0 = v0;
    this.v1 = v1;
    this.isLine = Boolean(isLine);
    this.controlPoints = controlPoints.map((p) => [Number(p[0]), Number(p[1])]);
    this.halfEdge0 = null;
    this.halfEdge1 = null;
  }

  getControl(index) {
    return this.controlPoints[index] ?? null;
  }

  setControl(index, x, y) {
    this.controlPoints[index] = [Number(x), Number(y)];
    this.isLine = false;
  }

  splitEdge(t = 0.5) {
    const clampedT = Math.max(0.01, Math.min(0.99, t));
    let midX;
    let midY;

    if (this.isLine || this.controlPoints.length === 0) {
      midX = this.v0.x + (this.v1.x - this.v0.x) * clampedT;
      midY = this.v0.y + (this.v1.y - this.v0.y) * clampedT;
      const midVertex = new Vertex(midX, midY);
      const edgeA = new Edge(this.v0, midVertex, true);
      const edgeB = new Edge(midVertex, this.v1, true);
      return { midVertex, edgeA, edgeB };
    }

    // Quadratic / Cubic Bézier subdivision (de Casteljau's algorithm)
    if (this.controlPoints.length === 1) {
      const c = this.controlPoints[0];
      const q0x = this.v0.x + (c[0] - this.v0.x) * clampedT;
      const q0y = this.v0.y + (c[1] - this.v0.y) * clampedT;
      const q1x = c[0] + (this.v1.x - c[0]) * clampedT;
      const q1y = c[1] + (this.v1.y - c[1]) * clampedT;
      midX = q0x + (q1x - q0x) * clampedT;
      midY = q0y + (q1y - q0y) * clampedT;

      const midVertex = new Vertex(midX, midY);
      const edgeA = new Edge(this.v0, midVertex, false, [[q0x, q0y]]);
      const edgeB = new Edge(midVertex, this.v1, false, [[q1x, q1y]]);
      return { midVertex, edgeA, edgeB };
    }

    // Default linear split for higher-order curves
    midX = this.v0.x + (this.v1.x - this.v0.x) * clampedT;
    midY = this.v0.y + (this.v1.y - this.v0.y) * clampedT;
    const midVertex = new Vertex(midX, midY);
    const edgeA = new Edge(this.v0, midVertex, true);
    const edgeB = new Edge(midVertex, this.v1, true);
    return { midVertex, edgeA, edgeB };
  }

  toJSON() {
    return {
      id: this.id,
      v0: this.v0?.id,
      v1: this.v1?.id,
      isLine: this.isLine,
      controlPoints: this.controlPoints,
    };
  }
}

export class Contour {
  constructor(orientation = 1, interior = true) {
    this.id = nextId++;
    this.orientation = orientation; // +1 = clockwise / outer, -1 = counter-clockwise / hole
    this.interior = Boolean(interior);
    this.halfEdges = [];
  }

  getHalfEdge() {
    return this.halfEdges[0] ?? null;
  }

  addHalfEdge(he) {
    he.contour = this;
    if (this.halfEdges.length > 0) {
      const prev = this.halfEdges[this.halfEdges.length - 1];
      prev.next = he;
      he.prev = prev;
    }
    this.halfEdges.push(he);
  }

  close() {
    if (this.halfEdges.length > 1) {
      const first = this.halfEdges[0];
      const last = this.halfEdges[this.halfEdges.length - 1];
      last.next = first;
      first.prev = last;
    }
  }

  getVertices() {
    return this.halfEdges.map((he) => he.vertex);
  }

  toJSON() {
    return {
      id: this.id,
      orientation: this.orientation,
      interior: this.interior,
      halfEdges: this.halfEdges.map((he) => he.id),
      vertices: this.getVertices().map((v) => ({ id: v.id, x: v.x, y: v.y })),
    };
  }
}

export class Shape {
  constructor() {
    this.contours = [];
    this.edges = [];
    this.vertices = [];
    this.styles = [];
  }

  addContour(contour) {
    this.contours.push(contour);
    for (const he of contour.halfEdges) {
      if (he.vertex && !this.vertices.includes(he.vertex)) {
        this.vertices.push(he.vertex);
      }
      if (he.edge && !this.edges.includes(he.edge)) {
        this.edges.push(he.edge);
      }
    }
  }

  /**
   * Create a standard Flash rectangle shape model:
   * 1 contour, 4 edges, 4 vertices, orientation = 1.
   */
  static createRectangle(x, y, width, height) {
    const shape = new Shape();
    const v0 = new Vertex(x, y);
    const v1 = new Vertex(x + width, y);
    const v2 = new Vertex(x + width, y + height);
    const v3 = new Vertex(x, y + height);

    const e0 = new Edge(v0, v1, true);
    const e1 = new Edge(v1, v2, true);
    const e2 = new Edge(v2, v3, true);
    const e3 = new Edge(v3, v0, true);

    const he0 = new HalfEdge(v0, e0);
    const he1 = new HalfEdge(v1, e1);
    const he2 = new HalfEdge(v2, e2);
    const he3 = new HalfEdge(v3, e3);
    e0.halfEdge0 = he0;
    e1.halfEdge0 = he1;
    e2.halfEdge0 = he2;
    e3.halfEdge0 = he3;

    const contour = new Contour(1, true);
    contour.addHalfEdge(he0);
    contour.addHalfEdge(he1);
    contour.addHalfEdge(he2);
    contour.addHalfEdge(he3);
    contour.close();

    shape.addContour(contour);
    return shape;
  }

  /**
   * Create a standard Flash brush outline ribbon:
   * Two contours with orientation +1 (outer) and -1 (inner).
   */
  static createBrushRibbon(leftPoints, rightPoints) {
    const shape = new Shape();
    if (!leftPoints || !rightPoints || leftPoints.length < 2) return shape;

    // Outer contour (+1 orientation)
    const outerContour = new Contour(1, true);
    const outerVertices = leftPoints.map((p) => new Vertex(p[0], p[1]));
    for (let i = 0; i < outerVertices.length; i += 1) {
      const vStart = outerVertices[i];
      const vNext = outerVertices[(i + 1) % outerVertices.length];
      const edge = new Edge(vStart, vNext, true);
      const he = new HalfEdge(vStart, edge);
      edge.halfEdge0 = he;
      outerContour.addHalfEdge(he);
    }
    outerContour.close();
    shape.addContour(outerContour);

    // Inner contour (-1 orientation)
    const innerContour = new Contour(-1, false);
    const innerVertices = rightPoints.slice().reverse().map((p) => new Vertex(p[0], p[1]));
    for (let i = 0; i < innerVertices.length; i += 1) {
      const vStart = innerVertices[i];
      const vNext = innerVertices[(i + 1) % innerVertices.length];
      const edge = new Edge(vStart, vNext, true);
      const he = new HalfEdge(vStart, edge);
      edge.halfEdge0 = he;
      innerContour.addHalfEdge(he);
    }
    innerContour.close();
    shape.addContour(innerContour);

    return shape;
  }

  /**
   * Dump topology in JSFL format matching `probes/probe-dump.jsfl` and `brush-smooth50.json`.
   */
  dumpJSFL() {
    return {
      contours: this.contours.map((c) => ({
        id: c.id,
        orientation: c.orientation,
        interior: c.interior,
        vertexCount: c.halfEdges.length,
        vertices: c.getVertices().map((v) => ({ x: v.x, y: v.y })),
      })),
      edgeCount: this.edges.length,
      vertexCount: this.vertices.length,
    };
  }

  toJSON() {
    return this.dumpJSFL();
  }
}

/**
 * Path Builder API (JSFL newPath / Path object).
 */
export class PathBuilder {
  constructor() {
    this.contours = [];
    this.currentContour = null;
    this.currentVertex = null;
  }

  newPath() {
    this.contours = [];
    this.currentContour = null;
    this.currentVertex = null;
    return this;
  }

  newContour() {
    this.currentContour = new Contour(1, true);
    this.contours.push(this.currentContour);
    this.currentVertex = null;
    return this;
  }

  addPoint(x, y) {
    if (!this.currentContour) this.newContour();
    const v = new Vertex(x, y);
    if (this.currentVertex) {
      const edge = new Edge(this.currentVertex, v, true);
      const he = new HalfEdge(this.currentVertex, edge);
      edge.halfEdge0 = he;
      this.currentContour.addHalfEdge(he);
    }
    this.currentVertex = v;
    return this;
  }

  addCurve(cx, cy, x, y) {
    if (!this.currentContour) this.newContour();
    const v = new Vertex(x, y);
    if (this.currentVertex) {
      const edge = new Edge(this.currentVertex, v, false, [[cx, cy]]);
      const he = new HalfEdge(this.currentVertex, edge);
      edge.halfEdge0 = he;
      this.currentContour.addHalfEdge(he);
    }
    this.currentVertex = v;
    return this;
  }

  addCubicCurve(xAnchor, yAnchor, x1, y1, x2, y2, xEnd, yEnd) {
    if (!this.currentContour) this.newContour();
    const v = new Vertex(xEnd, yEnd);
    if (this.currentVertex) {
      const edge = new Edge(this.currentVertex, v, false, [
        [x1, y1],
        [x2, y2],
      ]);
      const he = new HalfEdge(this.currentVertex, edge);
      edge.halfEdge0 = he;
      this.currentContour.addHalfEdge(he);
    }
    this.currentVertex = v;
    return this;
  }

  close() {
    if (this.currentContour) {
      this.currentContour.close();
      this.currentVertex = null;
    }
    return this;
  }

  makeShape() {
    const shape = new Shape();
    for (const c of this.contours) {
      shape.addContour(c);
    }
    return shape;
  }
}

/**
 * DrawingLayer Pen API (JSFL drawingLayer pen model).
 */
export class DrawingLayer {
  constructor() {
    this.pathBuilder = new PathBuilder();
    this.color = "#000000";
    this.drawing = false;
  }

  beginDraw(color = "#000000") {
    this.color = color;
    this.drawing = true;
    this.pathBuilder.newPath();
    return this;
  }

  moveTo(x, y) {
    if (!this.drawing) return this;
    this.pathBuilder.newContour();
    this.pathBuilder.addPoint(x, y);
    return this;
  }

  lineTo(x, y) {
    if (!this.drawing) return this;
    this.pathBuilder.addPoint(x, y);
    return this;
  }

  curveTo(cx, cy, x, y) {
    if (!this.drawing) return this;
    this.pathBuilder.addCurve(cx, cy, x, y);
    return this;
  }

  cubicCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!this.drawing) return this;
    const cur = this.pathBuilder.currentVertex ?? new Vertex(0, 0);
    this.pathBuilder.addCubicCurve(cur.x, cur.y, c1x, c1y, c2x, c2y, x, y);
    return this;
  }

  endDraw() {
    this.drawing = false;
    this.pathBuilder.close();
    return this.pathBuilder.makeShape();
  }
}

/**
 * The outline of a stroke as a shape.
 *
 * A brush stroke is a ribbon, and a ribbon is two contours of one shape: one
 * that walks the outside of the ink and one that walks the inside, each with
 * its orientation. Building the contours here means the model is what holds
 * the geometry of the stroke, and the painters only put it down.
 */
export function shapeFromRibbon(leftPoints, rightPoints) {
  return Shape.createBrushRibbon(leftPoints, rightPoints);
}

/**
 * The two sides of a stroke's outline, read back from its shape.
 *
 * The painters take these point lists and draw the ribbon, so the geometry
 * they draw is the geometry the model holds.
 */
export function ribbonFromShape(shape) {
  if (!shape || !Array.isArray(shape.contours) || shape.contours.length === 0) {
    return { left: [], right: [] };
  }
  const contourPoints = (contour) =>
    (contour?.getVertices?.() ?? []).map((vertex) => [vertex.x, vertex.y]);
  const left = contourPoints(shape.contours[0]);
  // The inner contour was stored in reverse, so it comes back in reverse to
  // give the right side in the order the painters expect.
  const right = shape.contours[1] ? contourPoints(shape.contours[1]).reverse() : [];
  return { left, right };
}

/**
 * The outline of a stroke as a shape, built from the stroke itself.
 *
 * A stroke that has no outline of its own (a line, a rectangle, an ellipse or
 * a fill) has no ribbon, so it gives no shape. A freehand stroke gives the
 * ribbon of its ink.
 */
export function shapeForStroke(stroke) {
  if (!stroke || stroke.kind || stroke.eraser) return null;
  const points = stroke.points ?? [];
  if (points.length < 2) return null;
  // The half width at every point: the pressure of the hand and the taper of
  // the ends, the same reading the other painters use.
  const radii = strokeRadii(stroke);
  const outline = strokeOutline(points, radii);
  if (!outline?.left?.length || !outline?.right?.length) return null;
  return shapeFromRibbon(outline.left, outline.right);
}

