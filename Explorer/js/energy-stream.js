/**
 * Spacetime Curvature — Three.js
 * Sagittarius A* gravity well simulation
 *
 * 33 wireframe cubes with mass, GR-corrected gravity,
 * surface capture (cubes follow the curvature).
 *
 * DYNAMIC RINGS: The concentric circle rings expand outward
 *   continuously along the curvature, creating a zoom-in illusion.
 *   Radial spokes remain fixed (static).
 *
 * PHYSICS (Sgr A* scaled to scene):
 *   GM = 120, R_s = 4, ISCO = 12
 *   Gravity: a = GM/r^2 * (1 + 3R_s/r)  [post-Newtonian]
 *   Angular momentum dissipation → clockwise inspiral
 *   Tidal spaghettification near event horizon
 *
 * Theme-aware: light = white + black, dark = black + neon green
 */
(function() {
    if (typeof THREE === 'undefined') return;
    const canvas = document.getElementById('energyCanvas');
    if (!canvas) return;

    /* ── Theme ─────────────────────────────────────── */
    function getTheme() {
        return document.documentElement.getAttribute('data-theme') || 'light';
    }
    function getColors() {
        const dark = getTheme() === 'dark';
        return {
            bg:       dark ? 0x000000 : 0xf5f5f5,
            grid:     dark ? 0x00ff00 : 0x000000,
            particle: dark ? 0x00ff00 : 0x000000,
            cube:     dark ? 0x00ff00 : 0x000000,
        };
    }

    /* ── Scene ─────────────────────────────────────── */
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 3000);
    camera.position.set(0, 10, 280);
    camera.lookAt(0, -30, 0);

    const renderer = new THREE.WebGLRenderer({
        canvas, alpha: false, antialias: true, powerPreference: 'low-power'
    });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    let colors = getColors();
    renderer.setClearColor(colors.bg, 1);

    /* ══════════════════════════════════════════════════
       PHYSICS — Sgr A* scaled to scene units
       ══════════════════════════════════════════════════ */
    const GM          = 120;
    const R_S         = 4;
    const R_ISCO      = 3 * R_S;  // = 12
    const R_SOFT      = 1.5;
    const ANG_MOM_LOSS = 0.001;   // Slow inspiral — cubes spiral many orbits
    const DT          = 1.0;
    const MIN_SPIRAL_RATIO = 0.6; // Min tangential/radial velocity ratio (enforces spiral)
    const CAPTURE_HEIGHT = 25;

    /* ── Gravity well surface ────────────────────── */
    const WELL_DEPTH = 90, WELL_SCALE = 12;

    function gravityY(r) {
        if (r < 0.5) r = 0.5;
        return -WELL_DEPTH * WELL_SCALE / (r + WELL_SCALE);
    }

    /* ── Grid group ──────────────────────────────── */
    const gridGroup = new THREE.Group();
    scene.add(gridGroup);
    const MAX_RADIUS = 300;
    const MIN_RADIUS = 3;

    /* ── Dynamic rings (expanding outward along curvature) ── */
    const RING_COUNT    = 30;
    const RING_SEGMENTS = 160;
    const RING_SPEED    = 0.002; // Phase advance per frame (full cycle ≈ 8.3s)
    const rings         = [];
    const ringMaterials = [];

    for (let i = 0; i < RING_COUNT; i++) {
        const positions = new Float32Array((RING_SEGMENTS + 1) * 3);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.LineBasicMaterial({
            color: colors.grid, transparent: true, opacity: 0.3
        });
        const line = new THREE.Line(geom, mat);
        gridGroup.add(line);
        rings.push({
            line, mat, geom,
            phase: i / RING_COUNT  // Evenly distributed initial phases
        });
        ringMaterials.push(mat);
    }

    /* ── Static radial spokes (straight lines — don't move) ── */
    const spokeMaterials = [];

    for (let i = 0; i < 48; i++) {
        const theta = (i / 48) * Math.PI * 2;
        const pts = [];
        for (let r = 2; r <= MAX_RADIUS; r += 1.5)
            pts.push(new THREE.Vector3(
                Math.cos(theta) * r, gravityY(r), Math.sin(theta) * r
            ));
        const mat = new THREE.LineBasicMaterial({
            color: colors.grid, transparent: true, opacity: 0.18
        });
        gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
        spokeMaterials.push(mat);
    }

    gridGroup.rotation.x = 0.12;

    /* ══════════════════════════════════════════════════
       33 CUBES — Mass-bearing objects in Sgr A* gravity
       ══════════════════════════════════════════════════ */
    const CUBE_COUNT = 33;
    const cubes      = [];
    const cubeGroup  = new THREE.Group();
    gridGroup.add(cubeGroup);

    const MASS_CLASSES = [
        { mass: 0.5,  size: 1,   geo: new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)) },
        { mass: 2,    size: 2,   geo: new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)) },
        { mass: 8,    size: 3.5, geo: new THREE.EdgesGeometry(new THREE.BoxGeometry(3.5, 3.5, 3.5)) },
        { mass: 30,   size: 6,   geo: new THREE.EdgesGeometry(new THREE.BoxGeometry(6, 6, 6)) },
    ];

    function randomSpawn() {
        const dist   = 100 + Math.random() * 350;
        const theta  = Math.random() * Math.PI * 2;
        const yHeight = 30 + Math.random() * 200;
        const xzDist = dist * (0.3 + Math.random() * 0.7);
        return new THREE.Vector3(
            Math.cos(theta) * xzDist, yHeight, Math.sin(theta) * xzDist
        );
    }

    function burstSpawn(base) {
        const s = 15 + Math.random() * 35;
        return new THREE.Vector3(
            base.x + (Math.random() - 0.5) * s,
            Math.max(15, base.y + (Math.random() - 0.3) * s * 0.5),
            base.z + (Math.random() - 0.5) * s
        );
    }

    function makeCube() {
        const roll = Math.random();
        const classIdx = roll < 0.45 ? 0 : roll < 0.75 ? 1 : roll < 0.92 ? 2 : 3;
        const mc = MASS_CLASSES[classIdx];

        const mat = new THREE.LineBasicMaterial({
            color: colors.cube, transparent: true,
            opacity: 0.10 + mc.mass * 0.015,
        });
        const mesh = new THREE.LineSegments(mc.geo, mat);
        mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
        cubeGroup.add(mesh);

        return {
            mesh, mat,
            mass: mc.mass,
            baseSize: mc.size,
            vx: 0, vy: 0, vz: 0,
            tx: (Math.random() - 0.5) * 0.008,
            ty: (Math.random() - 0.5) * 0.008,
            tz: (Math.random() - 0.5) * 0.006,
            active: false,
            onSurface: false,
            baseOpacity: 0.10 + mc.mass * 0.015,
        };
    }

    function spawnCubeAt(cube, pos) {
        cube.mesh.position.copy(pos);
        cube.active    = true;
        cube.onSurface = false;
        cube.mesh.visible = true;
        cube.mat.opacity  = cube.baseOpacity;
        cube.mesh.scale.set(1, 1, 1);

        const dx = pos.x, dz = pos.z;
        const r_xz = Math.sqrt(dx * dx + dz * dz) || 1;

        const v_circ = Math.sqrt(GM / r_xz);
        // 70-95% of circular → always spirals, never plunges straight
        const v_orbit = v_circ * (0.70 + Math.random() * 0.25);

        // Counter-clockwise tangent: (dz/r, 0, -dx/r) viewed from above
        cube.vx = (dz / r_xz) * v_orbit;
        cube.vy = -0.01 - Math.random() * 0.03;
        cube.vz = (-dx / r_xz) * v_orbit;
    }

    for (let i = 0; i < CUBE_COUNT; i++) cubes.push(makeCube());

    // Pre-populate 2 clusters mid-orbit
    for (let b = 0; b < 2; b++) {
        const origin = randomSpawn();
        const count  = 5 + Math.floor(Math.random() * 5);
        for (let j = 0; j < count; j++) {
            const idx = b * 12 + j;
            if (idx < CUBE_COUNT) {
                const p = j === 0 ? origin : burstSpawn(origin);
                spawnCubeAt(cubes[idx], p);
                cubes[idx].mesh.position.lerp(
                    new THREE.Vector3(0, gravityY(60), 0),
                    Math.random() * 0.4
                );
            }
        }
    }
    for (let i = 0; i < CUBE_COUNT; i++) {
        if (!cubes[i].active) cubes[i].mesh.visible = false;
    }

    /* ── Burst spawner ─────────────────────────────── */
    let burstTimer = 0;
    let nextBurstAt = 30 + Math.random() * 60;

    function triggerBurst() {
        const burstSize = 3 + Math.floor(Math.random() * 5);
        const origin = randomSpawn();
        let spawned = 0;
        for (let i = 0; i < CUBE_COUNT && spawned < burstSize; i++) {
            if (!cubes[i].active) {
                spawnCubeAt(cubes[i], spawned === 0 ? origin : burstSpawn(origin));
                spawned++;
            }
        }
        nextBurstAt = 30 + Math.random() * 80;
        burstTimer = 0;
    }

    /* ── Dust particles ────────────────────────────── */
    const DUST_COUNT = 600;
    const dustGeom   = new THREE.BufferGeometry();
    const dustPos    = new Float32Array(DUST_COUNT * 3);
    const dustData   = [];
    for (let i = 0; i < DUST_COUNT; i++) {
        const r = 10 + Math.random() * 300;
        const a = Math.random() * Math.PI * 2;
        const y = (Math.random() - 0.4) * 120;
        dustPos[i * 3]     = Math.cos(a) * r;
        dustPos[i * 3 + 1] = y;
        dustPos[i * 3 + 2] = Math.sin(a) * r;
        dustData.push({
            radius: r, angle: a, y,
            speed: 0.001 / Math.sqrt(r / 10) * (0.5 + Math.random())
        });
    }
    dustGeom.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    const dustMat = new THREE.PointsMaterial({
        color: colors.particle, size: 0.6,
        transparent: true, opacity: 0.2, sizeAttenuation: true
    });
    gridGroup.add(new THREE.Points(dustGeom, dustMat));

    /* ── Dome orbit camera ─────────────────────────── */
    const CAM_ORBIT_RADIUS = 280;   // Distance from center
    const CAM_MIN_Y        = 10;    // Plane level (at the grid)
    const CAM_MAX_Y        = 200;   // Top of dome
    const CAM_ORBIT_SPEED  = 0.001; // Full orbit ≈ 105s at 60fps
    let camAngle = 0;               // Start at angle 0 → plane level

    // Subtle mouse offset on top of orbit
    let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
    document.addEventListener('mousemove', e => {
        targetX = (e.clientX / innerWidth - 0.5) * 15;
        targetY = (e.clientY / innerHeight - 0.5) * 8;
    });

    /* ── Theme watcher ─────────────────────────────── */
    function applyThemeColors() {
        colors = getColors();
        renderer.setClearColor(colors.bg, 1);
        ringMaterials.forEach(m => m.color.setHex(colors.grid));
        spokeMaterials.forEach(m => m.color.setHex(colors.grid));
        dustMat.color.setHex(colors.particle);
        cubes.forEach(c => c.mat.color.setHex(colors.cube));
    }
    new MutationObserver(applyThemeColors).observe(
        document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }
    );

    /* ══════════════════════════════════════════════════
       ANIMATION
       ══════════════════════════════════════════════════ */
    const _dir = new THREE.Vector3();

    function animate() {
        requestAnimationFrame(animate);

        // ── Dome orbit: rainbow arc, 360°, always pointing at center ──
        camAngle += CAM_ORBIT_SPEED;

        // Dome height: (1-cos)/2 → 0 at angle 0 & 2π, 1 at angle π
        // Creates a rainbow arc: plane level → top of dome → plane level
        const domePhase = (1 - Math.cos(camAngle)) / 2;
        const camY = CAM_MIN_Y + domePhase * (CAM_MAX_Y - CAM_MIN_Y);

        // Horizontal orbit circle
        const camX = Math.cos(camAngle) * CAM_ORBIT_RADIUS;
        const camZ = Math.sin(camAngle) * CAM_ORBIT_RADIUS;

        // Subtle mouse offset layered on top
        mouseX += (targetX - mouseX) * 0.02;
        mouseY += (targetY - mouseY) * 0.02;

        camera.position.set(camX + mouseX, camY + mouseY, camZ);
        camera.lookAt(0, -30, 0);
        gridGroup.rotation.y -= 0.00015; // Clockwise rotation (viewed from above)

        // Burst spawner
        burstTimer++;
        if (burstTimer >= nextBurstAt) triggerBurst();

        /* ── Dynamic rings: expand outward along curvature ──
           Each ring has a phase (0→1) that advances each frame.
           Radius mapped with phase² for denser packing near center.
           Rings follow gravityY(r) so they curve into the funnel. */
        for (let ri = 0; ri < RING_COUNT; ri++) {
            const ring = rings[ri];
            ring.phase += RING_SPEED;
            if (ring.phase >= 1) ring.phase -= 1;

            // phase² mapping: rings cluster near center, spread at edge
            const t = ring.phase;
            const radius = MIN_RADIUS + t * t * (MAX_RADIUS - MIN_RADIUS);
            const y = gravityY(radius);

            // Opacity: brighter near center (deep well), fades at edge
            // Also fade in at birth and fade out at edge
            let opacity;
            if (t < 0.05) {
                opacity = (t / 0.05) * 0.55; // Fade in
            } else if (radius < 20) {
                opacity = 0.55;
            } else if (radius < 60) {
                opacity = 0.35;
            } else if (radius < 150) {
                opacity = Math.max(0.08, 0.3 - radius * 0.001);
            } else {
                // Fade out at edge
                const edgeFade = 1 - (radius - 150) / (MAX_RADIUS - 150);
                opacity = Math.max(0.02, 0.08 * edgeFade);
            }
            ring.mat.opacity = opacity;

            // Update circle vertex positions
            const pos = ring.geom.attributes.position.array;
            for (let j = 0; j <= RING_SEGMENTS; j++) {
                const theta = (j / RING_SEGMENTS) * Math.PI * 2;
                pos[j * 3]     = Math.cos(theta) * radius;
                pos[j * 3 + 1] = y;
                pos[j * 3 + 2] = Math.sin(theta) * radius;
            }
            ring.geom.attributes.position.needsUpdate = true;
        }

        /* ── Physics for each cube ── */
        for (let i = 0; i < CUBE_COUNT; i++) {
            const c = cubes[i];
            if (!c.active) continue;

            const pos  = c.mesh.position;
            const dx   = pos.x, dz = pos.z;
            const r_xz = Math.sqrt(dx * dx + dz * dz);
            const gridY = gravityY(r_xz);

            // Event horizon — consumed
            if (r_xz < R_S && pos.y < gridY + 5) {
                c.active = false;
                c.mesh.visible = false;
                continue;
            }

            // Surface capture
            if (!c.onSurface && r_xz < MAX_RADIUS) {
                const distAbove = pos.y - gridY;
                if (distAbove <= 0) {
                    c.onSurface = true;
                    pos.y = gridY;
                    c.vy = 0;
                } else if (distAbove <= CAPTURE_HEIGHT) {
                    if (distAbove < 3) {
                        c.onSurface = true;
                        pos.y = gridY;
                        c.vy = 0;
                    } else {
                        const attract = 0.06 * (1 - distAbove / CAPTURE_HEIGHT);
                        c.vy -= attract;
                    }
                }
            }

            const r_eff_xz = Math.max(r_xz, R_SOFT);
            const inv_rxz  = 1 / (r_xz || 1);

            if (c.onSurface) {
                /* ═══ ON SURFACE: slide along the curvature ═══ */
                const a_newton = GM / (r_eff_xz * r_eff_xz);
                const gr_corr  = 1 + 3 * R_S / r_eff_xz;
                const a_total  = a_newton * gr_corr;

                const radX = -dx * inv_rxz;
                const radZ = -dz * inv_rxz;

                c.vx += radX * a_total * DT;
                c.vz += radZ * a_total * DT;

                const tanX = radZ, tanZ = -radX; // Counter-clockwise tangent
                const v_tan = c.vx * tanX + c.vz * tanZ;
                const lossRate = ANG_MOM_LOSS * (1 + 2.0 / c.mass);
                c.vx -= tanX * v_tan * lossRate;
                c.vz -= tanZ * v_tan * lossRate;

                // Mild ISCO acceleration (still spiral, not plunge)
                if (r_xz < R_ISCO) {
                    const plunge = 0.005 * (R_ISCO - r_xz) / R_ISCO;
                    c.vx -= tanX * v_tan * plunge;
                    c.vz -= tanZ * v_tan * plunge;
                }

                // ── Enforce spiral: never let radial dominate tangential ──
                const v_rad_on = c.vx * radX + c.vz * radZ;
                const v_tan_on = c.vx * tanX + c.vz * tanZ;
                const absRad = Math.abs(v_rad_on);
                const absTan = Math.abs(v_tan_on);
                if (absTan < absRad * MIN_SPIRAL_RATIO && absRad > 0.01) {
                    // Boost tangential to maintain spiral (clockwise)
                    const boost = absRad * MIN_SPIRAL_RATIO - absTan;
                    const sign = v_tan_on >= 0 ? 1 : -1;
                    c.vx += tanX * boost * sign;
                    c.vz += tanZ * boost * sign;
                }

                pos.x += c.vx * DT;
                pos.z += c.vz * DT;

                const new_rxz = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
                pos.y = gravityY(new_rxz);

            } else {
                /* ═══ FREE FALLING: 3D gravity ═══ */
                _dir.set(-dx, gridY - pos.y, -dz);
                const dist3d = _dir.length() || 1;
                _dir.divideScalar(dist3d);

                const r_eff3d  = Math.max(dist3d, R_SOFT);
                const a_newton = GM / (r_eff3d * r_eff3d);
                const gr_corr  = 1 + 3 * R_S / r_eff3d;
                const a_total  = a_newton * gr_corr;

                c.vx += _dir.x * a_total * DT;
                c.vy += _dir.y * a_total * DT;
                c.vz += _dir.z * a_total * DT;

                const radX = -dx * inv_rxz;
                const radZ = -dz * inv_rxz;
                const tanX = radZ, tanZ = -radX; // Counter-clockwise tangent
                const v_tan_ff = c.vx * tanX + c.vz * tanZ;
                const lossRate = ANG_MOM_LOSS * (1 + 2.0 / c.mass);
                c.vx -= tanX * v_tan_ff * lossRate;
                c.vz -= tanZ * v_tan_ff * lossRate;

                // Enforce spiral for free-falling cubes too
                const v_rad_ff = c.vx * radX + c.vz * radZ;
                const absRadFF = Math.abs(v_rad_ff);
                const absTanFF = Math.abs(v_tan_ff);
                if (absTanFF < absRadFF * MIN_SPIRAL_RATIO && absRadFF > 0.01) {
                    const boost = absRadFF * MIN_SPIRAL_RATIO - absTanFF;
                    const sign = v_tan_ff >= 0 ? 1 : -1;
                    c.vx += tanX * boost * sign;
                    c.vz += tanZ * boost * sign;
                }

                pos.x += c.vx * DT;
                pos.y += c.vy * DT;
                pos.z += c.vz * DT;
            }

            // Tidal stretching
            if (r_xz < 60) {
                const tidalFactor = Math.min(3.0, 1 + (30 / (r_xz * r_xz + 10)) / c.mass);
                const speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy + c.vz * c.vz) || 1;
                const sx = 1 + (tidalFactor - 1) * Math.abs(c.vx / speed);
                const sy = 1 + (tidalFactor - 1) * Math.abs(c.vy / speed);
                const sz = 1 + (tidalFactor - 1) * Math.abs(c.vz / speed);
                const vol  = sx * sy * sz;
                const comp = Math.pow(1 / vol, 0.3);
                c.mesh.scale.set(sx * comp, sy * comp, sz * comp);
            }

            // Tidal spin-up
            const spinMult = r_xz < 20 ? 4.0 : r_xz < 50 ? 2.0 : r_xz < 100 ? 1.3 : 1.0;
            c.mesh.rotation.x += c.tx * spinMult;
            c.mesh.rotation.y += c.ty * spinMult;
            c.mesh.rotation.z += c.tz * spinMult;

            // Fade near event horizon
            if (r_xz < 20) {
                c.mat.opacity = Math.max(0.01, (r_xz / 20) * c.baseOpacity);
            }
        }

        /* ── Dust orbit ── */
        const dPos = dustGeom.attributes.position.array;
        for (let i = 0; i < DUST_COUNT; i++) {
            const d = dustData[i];
            d.angle += d.speed;
            dPos[i * 3]     = Math.cos(d.angle) * d.radius;
            dPos[i * 3 + 2] = Math.sin(d.angle) * d.radius;
        }
        dustGeom.attributes.position.needsUpdate = true;

        renderer.render(scene, camera);
    }

    animate();

    /* ── Resize ────────────────────────────────────── */
    window.addEventListener('resize', () => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight);
    });
})();
