import {
  AccessibleRouter,
  type AccessibilityWeightedRoute,
  type RouteSegment,
} from "@/core/accessibility/AccessibleRouter";

export interface AccessibilityCoordinate {
  lat: number;
  lng: number;
}

export interface AccessibleRouteResult {
  geometry: number[][];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  evaluation: AccessibilityWeightedRoute;
  warnings: string[];
  barriers: Array<{
    type: string;
    latitude: number;
    longitude: number;
    segmentIndex: number;
    message: string;
  }>;
  dataSource: "OpenRouteService";
}

export class RoutingProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
  ) {
    super(message);
    this.name = "RoutingProviderError";
  }
}

/** Accepts [latitude, longitude] or an object with lat/lng (or latitude/longitude). */
export function normalizeAccessibilityCoordinate(
  value: unknown,
): AccessibilityCoordinate | null {
  let lat: unknown;
  let lng: unknown;
  if (Array.isArray(value) && value.length >= 2) {
    [lat, lng] = value;
  } else if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    lat = candidate.lat ?? candidate.latitude;
    lng = candidate.lng ?? candidate.lon ?? candidate.longitude;
  }
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }
  return { lat, lng };
}

type ExtraRange = [number, number, number];

function rangesForStep(
  values: unknown,
  start: number,
  end: number,
): number[] {
  if (!Array.isArray(values)) return [];
  return (values as unknown[])
    .filter((entry): entry is ExtraRange =>
      Array.isArray(entry) &&
      entry.length >= 3 &&
      Number.isFinite(Number(entry[0])) &&
      Number.isFinite(Number(entry[1])) &&
      Number.isFinite(Number(entry[2])) &&
      Number(entry[0]) <= end &&
      Number(entry[1]) >= start,
    )
    .map((entry) => Number(entry[2]));
}

function steepnessToPercent(value: number): number {
  const mapping: Record<number, number> = {
    [-5]: 16,
    [-4]: 10,
    [-3]: 7,
    [-2]: 4,
    [-1]: 1,
    0: 0.5,
    1: 1,
    2: 4,
    3: 7,
    4: 10,
    5: 16,
  };
  return mapping[value] ?? 0;
}

function surfaceName(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const surfaces: Record<number, string> = {
    0: "unknown",
    1: "paved",
    2: "unpaved",
    3: "asphalt",
    4: "concrete",
    5: "cobblestone",
    6: "metal",
    7: "wood",
    8: "compacted_gravel",
    9: "fine_gravel",
    10: "gravel",
    11: "dirt",
    12: "ground",
    13: "ice",
    14: "paving_stones",
    15: "sand",
    16: "woodchips",
    17: "grass",
    18: "grass_paver",
  };
  return surfaces[value] ?? "unknown";
}

function distanceMeters(a: number[], b: number[]): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function elevationStats(points: number[][]): { gain: number; maxGrade: number } {
  let gain = 0;
  let maxGrade = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous.length < 3 || current.length < 3) continue;
    const elevationDelta = current[2] - previous[2];
    const distance = distanceMeters(previous, current);
    if (elevationDelta > 0) gain += elevationDelta;
    if (distance > 0) maxGrade = Math.max(maxGrade, (Math.abs(elevationDelta) / distance) * 100);
  }
  return { gain, maxGrade };
}

function overlappingStepValue(
  extras: Record<string, any>,
  name: string,
  start: number,
  end: number,
): number[] {
  return rangesForStep(extras?.[name]?.values, start, end);
}

function buildRouteSegments(
  steps: any[],
  geometry: number[][],
  extras: Record<string, any>,
): RouteSegment[] {
  return steps.map((step, index) => {
    const range = Array.isArray(step.way_points) ? step.way_points : [0, geometry.length - 1];
    const start = Math.max(0, Number(range[0]) || 0);
    const end = Math.min(geometry.length - 1, Number(range[1]) || start);
    const points = geometry.slice(start, end + 1);
    const { gain, maxGrade } = elevationStats(points);

    const steepness = overlappingStepValue(extras, "steepness", start, end);
    const suitability = overlappingStepValue(extras, "suitability", start, end);
    const surfaces = overlappingStepValue(extras, "surface", start, end);
    const suitabilityScore = suitability.length
      ? Math.min(...suitability)
      : undefined;
    const maxGradePercent = Math.max(
      maxGrade,
      ...steepness.map((value) => steepnessToPercent(value)),
    );
    const tags: Record<string, string> = {};
    if (suitabilityScore !== undefined) {
      tags.suitability = String(suitabilityScore);
      tags.wheelchair =
        suitabilityScore >= 8 ? "yes" : suitabilityScore >= 5 ? "limited" : "no";
    }
    const surface = surfaceName(surfaces[0]);
    if (surface) tags.surface = surface;

    const instruction = typeof step.instruction === "string" ? step.instruction : "";
    if (/stairs|steps/i.test(instruction)) tags.highway = "steps";
    const elevation = gain > 0 ? gain : 0;

    return {
      distance: Math.max(0, Number(step.distance) || 0),
      duration: Math.max(0, Number(step.duration) || 0),
      elevationGain: elevation,
      maxGradePercent,
      suitabilityScore,
      osmTags: tags,
      instruction: instruction || "Continue along the mapped route.",
      name: typeof step.name === "string" ? step.name : undefined,
    };
  });
}

export interface FetchAccessibleRouteOptions {
  wheelchairMode?: boolean;
  maxAllowedGradePercent?: number;
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export async function fetchAccessibleRoute(
  start: AccessibilityCoordinate,
  end: AccessibilityCoordinate,
  options: FetchAccessibleRouteOptions = {},
): Promise<AccessibleRouteResult> {
  const apiKey =
    options.apiKey ??
    process.env.ORS_API_KEY ??
    process.env.OPENROUTESERVICE_API_KEY;
  if (!apiKey) {
    throw new RoutingProviderError(
      "OpenRouteService is not configured. Set ORS_API_KEY in the server environment.",
      503,
    );
  }

  const wheelchairMode = options.wheelchairMode !== false;
  const profile = wheelchairMode ? "wheelchair" : "foot-walking";
  const baseUrl = (options.baseUrl ?? "https://api.openrouteservice.org/v2").replace(/\/$/, "");
  const endpoint = `${baseUrl}/directions/${profile}/geojson`;
  const fetchFn = options.fetchFn ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/geo+json, application/json",
      },
      body: JSON.stringify({
        coordinates: [
          [start.lng, start.lat],
          [end.lng, end.lat],
        ],
        elevation: true,
        instructions: true,
        extra_info: ["steepness", "suitability", "surface"],
        units: "m",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new RoutingProviderError(
      error instanceof Error ? `Routing provider request failed: ${error.message}` : "Routing provider request failed.",
      502,
    );
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    const statusCode = response.status === 401 || response.status === 403 ? 503 : 502;
    throw new RoutingProviderError(
      `OpenRouteService returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      statusCode,
    );
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new RoutingProviderError("OpenRouteService returned invalid JSON.");
  }

  const feature = payload?.features?.[0];
  const geometry = feature?.geometry?.coordinates;
  const properties = feature?.properties;
  const segments = properties?.segments;
  const rawSteps = Array.isArray(segments)
    ? segments.flatMap((segment: any) => Array.isArray(segment.steps) ? segment.steps : [])
    : [];
  if (
    !Array.isArray(geometry) ||
    geometry.length < 2 ||
    !Array.isArray(segments) ||
    segments.length === 0
  ) {
    throw new RoutingProviderError("OpenRouteService response did not contain route geometry and segments.");
  }

  const normalizedGeometry = geometry.filter(
    (point: unknown) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(Number(point[0])) &&
      Number.isFinite(Number(point[1])),
  ) as number[][];
  if (normalizedGeometry.length < 2) {
    throw new RoutingProviderError("OpenRouteService route geometry is invalid.");
  }

  const routeSegments = buildRouteSegments(
    rawSteps.length
      ? rawSteps
      : [{
          distance: properties.summary?.distance,
          duration: properties.summary?.duration,
          way_points: [0, normalizedGeometry.length - 1],
        }],
    normalizedGeometry,
    properties.extras ?? {},
  );

  const maxIncline = options.maxAllowedGradePercent ?? 8.33;
  const evaluation = new AccessibleRouter().evaluateRoute(
    routeSegments,
    wheelchairMode,
    maxIncline,
  );

  const warnings: string[] = [];
  const barriers: AccessibleRouteResult["barriers"] = [];
  routeSegments.forEach((segment, index) => {
    const wayPoints = rawSteps[index]?.way_points ?? [0, normalizedGeometry.length - 1];
    const point = normalizedGeometry[Math.max(0, Math.min(normalizedGeometry.length - 1, Number(wayPoints[0]) || 0))];
    if (!point) return;

    if (/steps|stairs/.test(segment.osmTags.highway ?? "")) {
      const message = "This route segment contains stairs.";
      warnings.push(message);
      barriers.push({
        type: "stairs",
        latitude: point[1],
        longitude: point[0],
        segmentIndex: index,
        message,
      });
    }
    if ((segment.maxGradePercent ?? 0) > maxIncline) {
      const message = `Steep incline detected (${(segment.maxGradePercent ?? 0).toFixed(1)}%).`;
      warnings.push(message);
      barriers.push({
        type: "steep_incline",
        latitude: point[1],
        longitude: point[0],
        segmentIndex: index,
        message,
      });
    }
    if (segment.suitabilityScore !== undefined && segment.suitabilityScore < 5) {
      const message = "OpenRouteService marked this segment as unsuitable for wheelchair travel.";
      warnings.push(message);
      barriers.push({
        type: "low_wheelchair_suitability",
        latitude: point[1],
        longitude: point[0],
        segmentIndex: index,
        message,
      });
    }
  });

  return {
    geometry: normalizedGeometry,
    totalDistanceMeters: Number(properties.summary?.distance) || evaluation.totalDistance,
    totalDurationSeconds: Number(properties.summary?.duration) || evaluation.totalDuration,
    evaluation,
    warnings: Array.from(new Set(warnings)),
    barriers,
    dataSource: "OpenRouteService",
  };
}
