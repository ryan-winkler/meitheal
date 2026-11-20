export interface LegacyContinuityEnrollmentOptions {
  database: string
  markerPath: string
  custodyDirectory: string
  manifestPath: string
  archivePath: string
  installationId: string
  appSlug: string
  image: string
  source: string
}
export function enrollLegacyContinuity(options: LegacyContinuityEnrollmentOptions): Promise<{ status: string; revision: string }>
