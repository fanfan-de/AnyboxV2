// Materials authored for the round Personal Agent avatar prototype.
export interface AgentLogoPreset {
  readonly id: string
  readonly name: string
  readonly source: string
}

export const agentLogoPresets: readonly AgentLogoPreset[] = [
  {
    id: 'blackhole', name: '黑洞',
    source: `#define u_base vec3(0.64313725, 0.25098039, 0.12549020)
#define u_light vec3(1.00000000, 0.77254902, 0.41960784)
#define u_density 0.65000000
#define u_seed 0.38999999

float bhGlow(float distanceToBand, float width) {
    float x = distanceToBand / width;
    return exp(-x * x);
}

vec3 paint(vec2 uv, float t, float edge) {
    vec2 p = uv * 2.0 - 1.0;
    float seconds = mod(max(t, 0.0), 5.0);
    float orbit = seconds * 1.2566371;
    float fade = smoothstep(0.0, 0.55, seconds) * (1.0 - smoothstep(4.48, 5.0, seconds));
    float spin = u_seed * 6.2831853 + orbit;
    float tilt = -0.19 + 0.027 * sin(u_seed * 2.3247786) + 0.29 * fade * sin(orbit);
    float inclination = 0.31 + 0.11 * fade * sin(orbit + 1.1);
    float c = cos(tilt), s = sin(tilt);
    p = mat2(c, -s, s, c) * p;

    float r = length(p);
    float azimuth = atan(p.y, p.x + 0.0001);
    float density = .65 + .27 * (u_density - .65);
    float haze = exp(-3.8 * length(vec2(p.x * 0.87, p.y * 1.56)));
    vec3 color = vec3(0.012, 0.009, 0.019) + (0.15 + 0.25 * density) * haze * u_base;

    // A thin view of the accretion disk, with a nearer side crossing the shadow.
    vec2 disk = vec2(p.x, (p.y + 0.012) / inclination);
    float diskRadius = length(disk);
    float diskAngle = atan(disk.y, disk.x + 0.0001);
    float turbulence = 0.76 + 0.24 * sin(2.0 * diskAngle - spin + diskRadius * 13.0);
    float stream = 0.5 + 0.5 * sin((17.0 + 7.7 * u_density) * diskRadius - 3.0 * diskAngle + u_seed * 3.9584067 + 2.0 * orbit);
    float diskFalloff = 1.0 - smoothstep(0.71, 0.99, diskRadius);
    float emission = bhGlow(diskRadius - 0.59, 0.165) * diskFalloff * turbulence;
    float hotDisk = bhGlow(diskRadius - 0.54, 0.077) * (0.66 + 0.34 * stream);
    float filament = bhGlow(diskRadius - 0.49, 0.023) * (0.64 + 0.36 * turbulence);
    float leftBoost = 0.74 + 0.30 * (1.0 - smoothstep(-0.45, 0.55, p.x));
    float inShadow = 1.0 - smoothstep(0.333, 0.369, r);
    float nearSide = 1.0 - smoothstep(-0.065, 0.022, p.y);
    float diskVisible = 1.0 - inShadow * (1.0 - nearSide);

    color = mix(color, vec3(0.003, 0.002, 0.008), inShadow);
    color += diskVisible * leftBoost * (u_base * emission * (0.67 + 0.33 * density)
        + u_light * (hotDisk * 0.67 + filament * 0.49));

    // Two compact hot knots orbit at separate radii and vanish behind the shadow.
    float path = diskAngle + 2.0 * orbit - u_seed * 1.9477874;
    float knotA = pow(max(0.0, cos(path)), 17.0) * bhGlow(diskRadius - 0.56, 0.078);
    float knotB = pow(max(0.0, cos(path - 2.8)), 13.0) * bhGlow(diskRadius - 0.65, 0.067);
    vec3 whiteHot = mix(u_light, vec3(1.0, 0.94, 0.82), 0.55);
    color += fade * diskVisible * leftBoost * whiteHot * (1.44 * knotA + 0.94 * knotB);

    // Gravitationally bent light from the far side makes an elevated crescent.
    float arcRadius = length(vec2(p.x * 0.94, (p.y + 0.005) * 1.06));
    float arcBend = 0.438 + 0.016 * cos(azimuth * 2.0 + 0.5);
    float upperArc = smoothstep(-0.105, 0.24, p.y);
    float arcPulse = 0.82 + 0.18 * cos(3.0 * azimuth - u_seed * 3.2672564 - orbit);
    float arc = upperArc * arcPulse * leftBoost;
    color += arc * (u_base * bhGlow(arcRadius - arcBend, 0.074) * 0.65
        + u_light * bhGlow(arcRadius - arcBend, 0.028) * 0.83
        + vec3(1.0, 0.84, 0.66) * bhGlow(arcRadius - arcBend, 0.012) * 0.28);

    float flare = pow(max(0.0, cos(azimuth + 2.0 * orbit + 1.2)), 13.0);
    color += fade * upperArc * flare * whiteHot * bhGlow(arcRadius - arcBend, 0.052) * 1.55;

    float photonRing = bhGlow(r - 0.36, 0.011) * (0.48 + 0.52 * upperArc);
    color += photonRing * u_light * 0.40;
    return vec3(1.0) - exp(-color * 1.42);
}`,
  },
  {
    id: 'flower', name: '一朵花',
    source: `#define u_base vec3(0.65882353, 0.28627451, 0.40784314)
#define u_light vec3(0.96862745, 0.72156863, 0.63921569)
#define u_density 0.50000000
#define u_seed 0.00022310

float flHash(float n) {
  return fract(sin(n * 71.173 + 14.719) * 41261.819);
}

float flWidth(float x, float spread) {
  return spread * sqrt(max(.0001, sin(3.14159265 * clamp(x, 0., 1.)))) * (.73 + .43 * x);
}

float flPetal(vec2 p, float length, float spread, float curl, out float x, out float side) {
  x = p.y / length;
  float s = clamp(x, 0., 1.);
  float width = flWidth(s, spread);
  float bend = curl * s * s;
  side = (p.x - bend) / width;
  return min(min(p.y, length - p.y), width - abs(p.x - bend));
}

float flSurface(vec2 p, float length, float spread, float curl, float lift) {
  float x, side;
  flPetal(p, length, spread, curl, x, side);
  x = clamp(x, 0., 1.);
  side = clamp(side, -1., 1.);
  float cross = side * side;
  // The petal is slightly cupped, with an upward curl toward the rim.
  return lift * x * x + .056 * sin(3.14159265 * x) * (1. - cross)
    + .036 * cross * cross * x + .018 * sin(8. * x + 2. * side) * x * cross;
}

vec3 paint(vec2 uv, float t, float edge) {
  const float tau = 6.2831853;
  vec2 q = (uv - .5) * 2.;
  float time = clamp(t, 0., 5.);
  float motion = sin(time * tau / 5.);
  float closed = smoothstep(.25, 1.88, time) * (1. - smoothstep(2.35, 4.63, time));
  float angleOffset = flHash(u_seed + .81) * tau + .105 * motion;
  q -= vec2(.045, -.032) * motion;
  float cs = cos(angleOffset);
  float sn = sin(angleOffset);
  vec2 p = mat2(cs, sn, -sn, cs) * q;
  p *= vec2(1.005, 1.09);

  float radial = length(q);
  vec3 ground = mix(vec3(.044, .030, .053), u_base * .21, .31 + .19 * q.y);
  ground *= 1.11 - .28 * radial * radial;
  float azimuth = -.62 + .19 * motion;
  vec3 lightDir = normalize(vec3(cos(azimuth) * -.57 + .19 * closed, .69, 1.));
  vec3 viewDir = vec3(0., 0., 1.);
  vec3 halfVec = normalize(lightDir + viewDir);
  float density = .5 + .35 * (u_density - .5);

  float best = -1.;
  float back = -1.;
  float bestMask = 0.;
  float shade = .0;
  float bestX = 0.;
  float bestSide = 0.;
  float pigment = 0.;
  float glint = 0.;
  float backMask = 0.;

  for (int i = 0; i < 13; ++i) {
    bool inner = i >= 8;
    float idx = float(inner ? i - 8 : i);
    float jitter = flHash(float(i) + u_seed * .71);
    // Each petal folds toward its own radial axis, with the inner petals following.
    float stagger = (jitter - .5) * .28 + (inner ? .31 : .0);
    float fold = smoothstep(.23 + stagger, 1.72 + stagger, time)
      * (1. - smoothstep(2.16 + stagger, 4.57 + stagger, time));
    float turn = fold * (.24 + jitter * .14) * (inner ? -1. : 1.);
    float tilt = fold * (inner ? .78 : .99);
    float a = (idx + (jitter - .5) * .29) * (inner ? tau / 5. : tau / 8.) + (inner ? .38 : .0) + turn;
    vec2 axial = vec2(cos(a), sin(a));
    vec2 tangent = vec2(axial.y, -axial.x);
    vec2 local = vec2(dot(p, tangent), dot(p, axial) + .048);
    float length = (inner ? .56 : .86) * (.91 + .16 * jitter) * cos(tilt);
    float spread = (inner ? .172 : .213) * (.91 + .17 * flHash(float(i) + u_seed + 4.1));
    spread *= mix(.93, 1.11, density) * (1. - .23 * fold);
    float curl = (flHash(float(i) + u_seed * .21 + 18.5) - .5) * .20;
    curl += turn * (inner ? .21 : .35);
    float lift = (inner ? .09 : .145) + .035 * jitter + .235 * sin(tilt);
    float x, side;
    float d = flPetal(local, length, spread, curl, x, side);
    float mask = smoothstep(-.012, .014, d);
    if (mask < .003) continue;

    float z = flSurface(local, length, spread, curl, lift) + (inner ? .038 : .0) + jitter * .045;
    if (z <= best) {
      back = max(back, z);
      backMask = max(backMask, mask);
      continue;
    }
    back = best;
    backMask = max(backMask, bestMask);
    best = z;
    bestMask = mask;
    float du = .009;
    float sx = (flSurface(local + vec2(du, 0.), length, spread, curl, lift)
      - flSurface(local - vec2(du, 0.), length, spread, curl, lift)) / (2. * du);
    float sy = (flSurface(local + vec2(0., du), length, spread, curl, lift)
      - flSurface(local - vec2(0., du), length, spread, curl, lift)) / (2. * du);
    vec2 slope = tangent * sx + axial * sy;
    vec2 rotated = mat2(cs, -sn, sn, cs) * slope;
    vec3 normal = normalize(vec3(-rotated, 1.));
    shade = max(0., dot(normal, lightDir));
    glint = pow(max(0., dot(normal, halfVec)), 21.);
    bestX = clamp(x, 0., 1.);
    bestSide = side;
    pigment = (inner ? .13 : .02) + jitter * .16;
  }

  vec3 color = ground;
  if (best >= 0.) {
    float rim = smoothstep(.72, 1.04, abs(bestSide));
    float tip = smoothstep(.27, .96, bestX);
    float seam = back >= 0. ? .72 + .28 * smoothstep(.003, .050, best - back) : 1.;
    float vein = .024 * sin(23. * bestSide + 5. * bestX)
      * sin(3.14159265 * bestX) * (1. - .68 * abs(bestSide));
    vec3 darkPetal = mix(u_base * .56, vec3(.20, .061, .10), .38);
    vec3 surface = mix(darkPetal, u_base, min(1., .41 + .56 * tip + pigment));
    surface = mix(surface, u_light, .11 + .38 * tip + .17 * rim * tip);
    surface *= (.56 + .49 * shade) * (.86 + .14 * seam) + vein;
    surface += u_light * (.072 * glint + .078 * rim * tip);
    float overlap = max(bestMask, backMask * .93);
    color = mix(ground, surface, overlap);
  }

  // A dark central disk with two staggered rings of individually lit stamens.
  vec2 heart = p / (1. - .29 * closed);
  float r = length(heart);
  float phi = atan(heart.y, heart.x);
  float disk = 1. - smoothstep(.154, .189, r);
  vec3 center = mix(vec3(.075, .034, .069), u_base * .46, .23 + .30 * smoothstep(.033, .175, r));
  center *= .80 + .19 * cos(phi + .57) + .12 * sin(87. * r + 5. * phi) * sin(31. * phi);
  color = mix(color, center, disk);
  float stamens = 0.;
  float warmth = 0.;
  for (int j = 0; j < 2; ++j) {
    float ring = float(j);
    float count = 12. + 7. * ring;
    float index = floor((phi + tau) * count / tau + .5 + ring * .5) - ring * .5;
    float a = index * tau / count;
    float rand = flHash(index + ring * 17. + u_seed);
    vec2 st = vec2(cos(a), sin(a)) * (.090 + ring * .058 + .011 * rand);
    vec2 delta = heart - st;
    float size = (.014 + .0035 * rand) * mix(.90, 1.13, density);
    float dotMask = 1. - smoothstep(.72, 1.08, length(delta) / size);
    stamens = max(stamens, dotMask);
    warmth = max(warmth, dotMask * (.78 + .22 * smoothstep(-size, size, delta.y)));
  }
  vec3 pollen = mix(vec3(.77, .48, .235), u_light, .36);
  return mix(color, pollen * (.67 + .33 * warmth), (.88 - .36 * closed) * stamens);
}`,
  },
  {
    id: 'cat', name: '可爱的猫',
    source: `#define u_base vec3(0.51372549, 0.55686275, 0.74901961)
#define u_light vec3(1.00000000, 0.88235294, 0.72941176)
#define u_density 1.00000000
#define u_seed 0.17000002

float catEll(vec2 p, vec2 r) {
  return (length(p/r)-1.)*min(r.x,r.y);
}
float catTri(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 e0=b-a, e1=c-b, e2=a-c;
  vec2 v0=p-a, v1=p-b, v2=p-c;
  vec2 q0=v0-e0*clamp(dot(v0,e0)/dot(e0,e0),0.,1.);
  vec2 q1=v1-e1*clamp(dot(v1,e1)/dot(e1,e1),0.,1.);
  vec2 q2=v2-e2*clamp(dot(v2,e2)/dot(e2,e2),0.,1.);
  float w=sign(e0.x*e2.y-e0.y*e2.x);
  vec2 d=min(min(vec2(dot(q0,q0),w*(v0.x*e0.y-v0.y*e0.x)),
    vec2(dot(q1,q1),w*(v1.x*e1.y-v1.y*e1.x))),
    vec2(dot(q2,q2),w*(v2.x*e2.y-v2.y*e2.x)));
  return -sqrt(d.x)*sign(d.y);
}
float catJoin(float a,float b,float k) {
  float h=max(k-abs(a-b),0.)/k;
  return min(a,b)-h*h*k*.25;
}
float catInk(float d) {
  float aa=max(fwidth(d)*.70,.002);
  return 1.-smoothstep(-aa,aa,d);
}
float catSeg(vec2 p,vec2 a,vec2 b) {
  vec2 pa=p-a, ba=b-a;
  return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));
}
float catGlow(vec2 p,vec2 r) {
  vec2 k=p/r;
  return exp(-dot(k,k));
}
float catBeat(float t,float rise,float peak,float hold,float release) {
  return smoothstep(rise,peak,t)*(1.-smoothstep(hold,release,t));
}
vec3 paint(vec2 uv,float t,float edge) {
  vec2 p=uv-.5;
  float time=mod(t,5.);
  float crouch=catBeat(time,.16,.32,.32,.56);
  float lean=catBeat(time,.34,.87,1.47,2.08);
  float peek=catBeat(time,1.62,2.22,2.82,3.42);
  float hop=catBeat(time,3.16,3.62,3.63,4.21);
  float land=catBeat(time,3.86,4.13,4.15,4.63);
  vec2 movement=vec2(.062*lean-.065*peek,.036*lean+.006*peek+.078*hop-.023*land-.026*crouch);
  vec2 f=p-movement;
  float pose=(u_seed-.17)*.35+.36*lean-.40*peek+.17*hop;
  f=mat2(cos(pose),sin(pose),-sin(pose),cos(pose))*f;
  f*=vec2(1.-.18*(u_seed-.17),1.+.07*(u_seed-.17));
  f*=vec2(1.-.065*(land+crouch)+.045*hop,1.+.11*(land+crouch)-.061*hop);
  float density=clamp(u_density,0.,2.);
  float lamp=.95+.05*sin(time*1.25663706+fract(u_seed)*3.);
  vec3 pink=vec3(1.,.57,.51);
  vec3 shell=mix(u_light,vec3(1.,.83,.63),.24);
  vec3 shade=mix(shell,vec3(.58,.27,.25),.39);
  vec3 milk=mix(shell,vec3(1.,.98,.90),.60);
  vec3 ink=mix(vec3(.19,.090,.108),u_base,.13);
  vec3 c=mix(u_base*.85,mix(u_base,vec3(1.,.92,.89),.39),
    catGlow(p-vec2(-.12,.19),vec2(.56,.54))*lamp);
  float drop=catGlow(p-vec2(.026+movement.x*.72,-.194+movement.y*.19),vec2(.297-.032*hop,.128));
  c=mix(c,ink,drop*(.21-.08*hop));
  bool right=f.x>0.;
  float flick=right ? catBeat(time,2.20,2.36,2.41,2.67)-.60*catBeat(time,2.53,2.67,2.71,2.90)
    : catBeat(time,.78,.93,.98,1.24)-.56*catBeat(time,.99,1.16,1.20,1.41);
  float earMotion=.28*flick+(right ? -.09*lean+.17*peek : .14*lean-.08*peek);
  vec2 q=vec2(abs(f.x),f.y);
  float earWeight=smoothstep(.08,.32,f.y);
  vec2 e=q-vec2(earMotion*(f.y-.085),earWeight*(.035*flick-.021*land));
  float ear=catTri(e,vec2(.033,.122),vec2(.213,.324),vec2(.282,.073))-.027;
  vec3 earClay=mix(shade,milk,clamp(.53+.99*e.y-.58*e.x,0.,1.));
  earClay=mix(earClay,shade,(1.-smoothstep(.0,.024,-ear))*.25);
  c=mix(c,earClay,catInk(ear));
  float inner=catTri(e,vec2(.103,.137),vec2(.208,.270),vec2(.244,.112))-.017;
  vec3 innerPink=mix(vec3(.79,.40,.38),mix(pink,shell,.28),smoothstep(.105,.28,e.y));
  float earSmile=catGlow(e-vec2(.199,.222),vec2(.038,.083));
  c=mix(c,mix(innerPink,milk,earSmile*.28),catInk(inner)*.89);
  float head=catJoin(catEll(f-vec2(0.,-.005),vec2(.267,.206)),
    catEll(f-vec2(0.,-.096),vec2(.286,.169)),.045);
  float region=catInk(head);
  float bevel=smoothstep(0.,.10,-head);
  vec3 clay=mix(shade,shell,clamp(.33+bevel*.55+f.y*.48-f.x*.28,0.,1.));
  float sheen=catGlow(f-vec2(-.11,.13),vec2(.20,.10));
  clay=mix(clay,milk,sheen*.57*lamp);
  float muzzle=catGlow(f-vec2(-.003,-.135),vec2(.135,.077));
  clay=mix(clay,milk,muzzle*.78);
  float cheeks=catGlow(q-vec2(.179,-.112),vec2(.068,.037));
  clay=mix(clay,pink,cheeks*(.55+.06*density));
  c=mix(c,clay,region);
  float blinkBoth=catBeat(time,.18,.255,.29,.44)+catBeat(time,3.14,3.28,3.35,3.51);
  float wink=right ? catBeat(time,1.10,1.27,1.48,1.68) : 0.;
  float blink=1.-.98*max(blinkBoth,wink);
  vec2 gaze=vec2(.022*lean-.026*peek,.017*peek+.012*hop);
  vec2 eyeCenter=vec2(right ? .107 : -.107,-.019)+gaze;
  vec2 eye=f-eyeCenter;
  eye.x*=right ? 1. : -1.;
  vec2 er=vec2(.037,.050*blink+.003+.008*hop*blink);
  float eyelash=catInk(catEll(eye+vec2(0.,.002),er+vec2(.006,.004)));
  vec3 iris=mix(ink,vec3(.43,.235,.185),catGlow(eye-vec2(.005,-.025*blink),vec2(.037,.029*blink+.003))*.78);
  c=mix(c,mix(shade,ink,.63),eyelash*.56);
  c=mix(c,iris,catInk(catEll(eye,er)));
  vec2 glint=f-eyeCenter-vec2(-.011,.016*blink);
  c=mix(c,vec3(1.,.985,.955),catInk(catEll(glint,vec2(.011,.010*blink+.002)))*smoothstep(.23,.72,blink));
  c=mix(c,milk,catInk(catEll(f-eyeCenter-vec2(.012,-.015*blink),vec2(.005,.005)))*smoothstep(.35,.88,blink)*.84);
  float nose=catTri(f,vec2(-.022,-.086),vec2(.022,-.086),vec2(0.,-.109))-.008;
  vec3 noseTint=mix(vec3(.64,.285,.30),vec3(.91,.48,.46),smoothstep(-.106,-.076,f.y));
  c=mix(c,noseTint,catInk(nose));
  c=mix(c,milk,catInk(catEll(f-vec2(-.006,-.081),vec2(.011,.0035)))*.56);
  vec2 smile=q-vec2(.029,-.124);
  float lip=catInk(abs(length(smile*vec2(1.,1.45))-.029)-.00365);
  lip*=1.-smoothstep(-.123,-.117,f.y);
  float philtrum=catInk(catSeg(f,vec2(0.,-.106),vec2(0.,-.126))-.0031);
  float surprise=smoothstep(.30,.79,hop);
  float openMouth=catInk(catEll(f-vec2(0.,-.145),vec2(.020,.022)));
  c=mix(c,mix(ink,noseTint,.29),mix(max(philtrum,lip),openMouth,surprise)*.87);
  float tongue=catInk(catEll(f-vec2(0.,-.155),vec2(.011,.007)));
  c=mix(c,noseTint,tongue*openMouth*surprise);
  float whisker=min(catSeg(q,vec2(.154,-.127),vec2(.234,-.112)),
    catSeg(q,vec2(.153,-.145),vec2(.222,-.151)));
  c=mix(c,mix(shade,ink,.30),catInk(whisker-.00235)*.55*region);
  return c;
}`,
  },
  {
    id: 'workaholic', name: '工作狂',
    source: `#define u_base vec3(0.15294118, 0.42745098, 0.47450980)
#define u_light vec3(1.00000000, 0.71372549, 0.41960784)
#define u_density 1.10000000
#define u_seed 0.42522067

float whBox(vec2 p, vec2 size, float rounding) {
  vec2 d=abs(p)-size+rounding;
  return min(max(d.x,d.y),0.)+length(max(d,0.))-rounding;
}
float whStroke(vec2 p, vec2 a, vec2 b) {
  vec2 ab=b-a;
  return length(p-a-ab*clamp(dot(p-a,ab)/dot(ab,ab),0.,1.));
}
float whInk(float d) {
  float aa=max(.002,fwidth(d)*.68);
  return 1.-smoothstep(-aa,aa,d);
}
float whGlow(vec2 p, vec2 radius) {
  vec2 q=p/radius;
  return exp(-dot(q,q));
}
mat2 whRotate(float a) {
  return mat2(cos(a),sin(a),-sin(a),cos(a));
}

vec3 paint(vec2 uv,float t,float edge) {
  const float tau=6.2831853;
  vec2 p=uv*2.-1.;
  float beat=tau*t*.2;
  float checkTime=fract(t*.8+.48);
  float glance=pow(max(0.,cos(beat-2.65)),5.);
  float pulse=pow(max(0.,cos(beat-3.5)),4.);
  float pose=(u_seed-.425)*.26;
  vec3 night=mix(vec3(.013,.021,.043),u_base*.25,.45);
  vec3 aqua=mix(u_base,vec3(.63,.96,.88),.67);
  vec3 warm=mix(u_light,vec3(1.,.94,.66),.15);
  vec3 c=night+u_base*.38*whGlow(p+vec2(.05,.04),vec2(.72,.61));

  // A late-night crescent and the small pool of light under the desk.
  vec2 moon=p-vec2(-.55,.51);
  float crescent=max(length(moon)-.095,.081-length(moon-vec2(.042,.035)));
  c+=warm*.095*whGlow(moon,vec2(.24,.22));
  c=mix(c,warm*.76,whInk(crescent));
  c+=u_base*.36*whGlow(p-vec2(0.,-.51),vec2(.69,.21));

  // Task rows move up and are replaced as the foremost checkbox completes.
  vec2 queue=p-vec2(.58,.355);
  float queueBox=whBox(queue,vec2(.19,.233),.049);
  c=mix(c,aqua*.24,whInk(queueBox));
  c=mix(c,night+u_base*.35,whInk(queueBox+.015));
  float push=smoothstep(.76,1.,checkTime)*.095;
  for(int row=-1; row<3; ++row) {
    float i=float(row);
    vec2 r=queue-vec2(0.,.102-i*.095+push);
    float crop=1.-smoothstep(.163,.2,abs(queue.y));
    float checked=(1.-smoothstep(-.5,.4,i))*smoothstep(.15,.48,checkTime);
    float box=whBox(r+vec2(.098,0.),vec2(.026,.026),.008);
    vec3 ink=mix(aqua*.76,warm,checked);
    c=mix(c,ink,whInk(box)*crop);
    c=mix(c,night,whInk(box+.008)*(1.-checked)*crop);
    float tick=min(whStroke(r,vec2(-.112,-.001),vec2(-.101,-.012)),whStroke(r,vec2(-.101,-.012),vec2(-.083,.014)));
    c=mix(c,night,whInk(tick-.0045)*checked*crop);
    float bar=whBox(r-vec2(.041,0.),vec2(.079-.016*mod(i+2.,3.),.011),.01);
    c=mix(c,ink*.64,whInk(bar)*crop);
  }

  // Ceramic body and focused visor. The head dips without interrupting typing.
  float torso=whBox(p-vec2(-.064,-.225),vec2(.274,.19),.121);
  c=mix(c,mix(night,aqua,.52),whInk(torso));
  vec2 head=whRotate(pose+.17*glance)*(p-vec2(-.105+.045*glance,.176-.075*glance+.022*sin(beat*3.)));
  float shell=whBox(head,vec2(.424,.279),.123);
  float drop=whBox(head+vec2(-.008,.033),vec2(.44,.284),.128);
  c=mix(c,night*.57,whInk(drop)*.58);
  float ears=whBox(vec2(abs(head.x)-.433,head.y+.025),vec2(.057,.116),.046);
  c=mix(c,mix(u_base,aqua,.47),whInk(ears));
  vec3 ceramic=mix(u_base,aqua,smoothstep(-.34,.32,head.y-.35*head.x));
  ceramic=mix(ceramic,aqua,.24+.19*whGlow(head-vec2(-.21,.195),vec2(.31,.16)));
  c=mix(c,ceramic,whInk(shell));
  float visor=whBox(head-vec2(0.,.008),vec2(.345,.194),.09);
  vec3 glass=mix(night,aqua,.10+.11*whGlow(head-vec2(-.13,.10),vec2(.37,.23)));
  c=mix(c,glass,whInk(visor));
  float look=.052*glance-.02*sin(beat);
  vec2 eye=vec2(abs(head.x-look)-.129,head.y-.013);
  eye.y+=.30*eye.x;
  float blink=pow(max(0.,cos(beat-4.99)),100.);
  float eyeBar=whBox(eye,vec2(.061,.045*(1.-.85*blink)+.009),.033*(1.-.80*blink));
  c+=aqua*.31*whGlow(eye,vec2(.12,.10))*whInk(visor);
  c=mix(c,mix(aqua,vec3(.91,1.,.93),.61),whInk(eyeBar));

  // A deadline lamp and the luminous keyboard deck.
  float stem=whStroke(head,vec2(.12,.252),vec2(.12,.365));
  c=mix(c,aqua*.72,whInk(stem-.018));
  vec2 lamp=head-vec2(.12,.378);
  vec3 ember=mix(warm,vec3(1.,.39,.23),pulse*.86);
  c+=ember*(.15+.13*pulse)*whGlow(lamp,vec2(.135,.13));
  c=mix(c,ember,whInk(length(lamp)-.048));
  vec2 board=p-vec2(0.,-.487);
  board.x*=1.+1.35*board.y;
  float deck=whBox(board,vec2(.57,.144),.078);
  c=mix(c,aqua*.72,whInk(deck));
  c=mix(c,mix(night,u_base,.54),whInk(deck+.019));
  float typing=beat*12.;
  for(int side=0;side<2;++side) {
    float s=side==0?-1.:1.;
    float strike=typing+float(side)*3.14159265;
    float lift=pow(.5+.5*sin(strike),1.42);
    float tap=pow(1.-lift,4.);
    vec2 mark=p-vec2(s*.231,-.458);
    float keyGrid=abs(fract((mark.x+.059)*8.45)-.5);
    float key=whBox(vec2((keyGrid-.20)*.13,abs(mark.y+.016)-.044),vec2(.026,.027),.01);
    float mask=whInk(key)*whInk(deck+.034)*whInk(abs(mark.x)-.22);
    c=mix(c,mix(aqua*.53,warm,.28+.67*tap*whGlow(mark,vec2(.12,.15))),mask);
    vec2 hand=vec2(s*(.208+.055*cos(strike))-.035,-.375+.175*lift);
    vec2 shoulder=vec2(s*.319-.075,-.229);
    float arm=whStroke(p,shoulder,hand);
    c=mix(c,mix(u_base,aqua,.37),whInk(arm-.056));
    vec2 palm=whRotate(s*(.26-.16*lift))*(p-hand);
    float mitten=whBox(palm,vec2(.086,.063),.052);
    vec3 glove=mix(warm*.62,warm,.48+.41*smoothstep(-.06,.059,palm.y));
    c=mix(c,glove,whInk(mitten));
    c+=warm*.12*tap*whGlow(mark,vec2(.11,.12));
  }

  float desk=whStroke(p,vec2(-.60,-.651),vec2(.60,-.651));
  c=mix(c,mix(u_base,aqua,.42),whInk(desk-.013)*.75);
  float grain=fract(sin(dot(floor(uv*200.),vec2(35.12,97.31)))*7313.73)-.5;
  return c*(1.-.14*edge)+.018*u_density*grain;
}`,
  },
]
