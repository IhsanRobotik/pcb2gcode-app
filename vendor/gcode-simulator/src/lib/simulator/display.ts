/** Enlarge shallow cuts while keeping clearance and tool-change heights in mm. */
export function displayZ(z: number, reliefScale: number): number {
	return z < 0 ? z * reliefScale : z;
}
