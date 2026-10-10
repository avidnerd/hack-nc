// Scrub+ volume ray-marcher — vertex stage.
//
// The volume is a box scaled to the specimen's real millimetre proportions. We
// render its BACK faces, so every fragment is guaranteed to be behind the
// volume from the camera's point of view; the fragment shader then walks from
// the camera toward that fragment. Marching this direction (rather than from
// the front faces) keeps working when the camera is pushed inside the volume,
// which happens constantly when a judge pinch-zooms in.

out vec3 vObjPos;
out vec3 vCamObj;

void main() {
  vObjPos = position;

  // Camera position in this mesh's object space. `modelMatrix` is rigid plus
  // uniform-per-axis scale, so inverting it is safe here.
  vCamObj = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
