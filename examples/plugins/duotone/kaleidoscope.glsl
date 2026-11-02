// Folds the picture round its centre into mirrored wedges, like a kaleidoscope.
// Pixl gives every effect src()/srcDocC() (the picture), docSize(), toDoc()/fromDoc(), lum(), hash() and vnoise();
// each setting in plugin.json is a uniform named u_<key>.
vec4 fx(vec2 p, vec2 d) {
  vec2 c = docSize() * 0.5, v = d - c;
  float seg = 6.28318 / max(u_segments, 2.0);
  float a = mod(atan(v.y, v.x) + radians(u_turn), seg);
  if (a > seg * 0.5) a = seg - a;
  return srcDocC(c + vec2(cos(a), sin(a)) * length(v));
}
