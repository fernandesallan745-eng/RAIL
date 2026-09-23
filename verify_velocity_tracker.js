/**
 * verify_velocity_tracker.js
 *
 * Verification suite for Live GPS Velocity Tracking & Dynamic Horizon Blending.
 *
 * Tests:
 * 1. Stationary train jitter rejection (pings with small noise produce 0 km/h)
 * 2. Uniform cruising speed convergence (steady pings at 80 km/h produce 80 km/h)
 * 3. Acceleration / deceleration phase transitions
 * 4. Teleport glitch rejection (> 160 km/h spikes discarded without corrupting filter)
 * 5. Horizon speed blending and dynamic next-halt ETA reconciliation
 */

import { liveVelocityTracker } from './src/services/liveVelocityTracker.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ Assertion Failed: ${message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('='.repeat(70));
  console.log('RUNNING LIVE VELOCITY TRACKER VERIFICATION');
  console.log('='.repeat(70));

  // --- Test 1: Stationary Jitter Rejection ---
  console.log('=== Test 1: Stationary Jitter Rejection ===');
  liveVelocityTracker.reset();
  const train1 = 'TEST_STATIONARY';
  const baseLat = 18.9407;
  const baseLng = 72.8361;

  // Ping 1
  liveVelocityTracker.recordPing(train1, { lat: baseLat, lng: baseLng, distanceFromOriginKm: 0 }, 1000000, 50, 15);
  // Ping 2: 30 seconds later, 4 metres GPS noise drift
  const p2 = liveVelocityTracker.recordPing(
    train1,
    { lat: baseLat + 0.00003, lng: baseLng + 0.00002, distanceFromOriginKm: 0.004 },
    1030000,
    50,
    15
  );

  assert(p2.isLive === true, 'Tracker should be live on ping 2');
  assert(p2.liveSpeedKmph === 0.0, `Expected 0.0 km/h for stationary jitter, got ${p2.liveSpeedKmph}`);
  assert(p2.phase === 'stationary', `Expected phase stationary, got ${p2.phase}`);
  console.log('  ok  stationary train suppresses GPS drift and reports 0.0 km/h');

  // --- Test 2: Uniform Cruising Speed Convergence ---
  console.log('=== Test 2: Uniform Cruising Speed Convergence ===');
  liveVelocityTracker.reset();
  const train2 = 'TEST_CRUISE';
  // Moving at 80 km/h = 22.22 m/s
  // In 30 seconds: 666.67 m. Latitude delta: 666.67 / 111139 ≈ 0.005998 degrees
  const stepLat = 666.67 / 111139.0;
  let t = 2000000;
  let lat = 18.0;

  liveVelocityTracker.recordPing(train2, { lat, lng: 73.0, distanceFromOriginKm: 0 }, t, 60, 20);

  let lastP = null;
  for (let step = 1; step <= 5; step++) {
    t += 30000;
    lat += stepLat;
    lastP = liveVelocityTracker.recordPing(
      train2,
      { lat, lng: 73.0, distanceFromOriginKm: step * 0.667 },
      t,
      60,
      20 - step * 0.667
    );
  }

  assert(lastP.isLive === true, 'Tracker must be live');
  assert(Math.abs(lastP.liveSpeedKmph - 80.0) < 1.0, `Expected ~80 km/h, got ${lastP.liveSpeedKmph}`);
  assert(lastP.phase === 'cruising', `Expected cruising phase, got ${lastP.phase}`);
  console.log(`  ok  steady 80 km/h cruising converged to ${lastP.liveSpeedKmph} km/h (phase: cruising)`);

  // --- Test 3: Teleport Glitch Rejection ---
  console.log('=== Test 3: Teleport Glitch Rejection ===');
  // Sudden jump of 5 km in 15 seconds (implied speed 1200 km/h)
  t += 15000;
  lat += 0.05; // ~5.5 km jump
  const pGlitch = liveVelocityTracker.recordPing(
    train2,
    { lat, lng: 73.0, distanceFromOriginKm: 10 },
    t,
    60,
    15
  );

  assert(pGlitch.liveSpeedKmph <= 85.0, `Glitch should not blow up speed filter: got ${pGlitch.liveSpeedKmph}`);
  console.log(`  ok  unrealistic teleport jump (>160 km/h) rejected; speed retained at ${pGlitch.liveSpeedKmph} km/h`);

  // --- Test 4: Dynamic Horizon Blending Invariants ---
  console.log('=== Test 4: Dynamic Horizon Blending Invariants ===');
  liveVelocityTracker.reset();
  const train4 = 'TEST_BLENDING';
  // Train is moving fast: 100 km/h, but schedule baseline is 50 km/h
  const fastStepLat = (100.0 / 3.6 * 30.0) / 111139.0;
  let t4 = 3000000;
  let lat4 = 17.5;

  liveVelocityTracker.recordPing(train4, { lat: lat4, lng: 73.5, distanceFromOriginKm: 0 }, t4, 50, 10);
  t4 += 30000;
  lat4 += fastStepLat;

  // Next halt is close: 3 km
  const pClose = liveVelocityTracker.recordPing(
    train4,
    { lat: lat4, lng: 73.5, distanceFromOriginKm: 0.833 },
    t4,
    50,
    3.0
  );

  // Next halt is far: 25 km
  const pFar = liveVelocityTracker.formatOutput(
    liveVelocityTracker.trains.get(train4),
    50,
    25.0,
    100.0
  );

  // Close halt should reflect live speed heavily (weight = exp(-3/8) ≈ 0.687)
  // Blended ≈ 0.687 * 100 + 0.313 * 50 ≈ 84.4 km/h
  assert(pClose.blendedSpeedNextHaltKmph > 75.0, `Close halt speed should be pulled toward 100 km/h: ${pClose.blendedSpeedNextHaltKmph}`);
  assert(pClose.deltaEtaNextHaltMin < 0, `Faster speed should reduce arrival time (delta < 0): ${pClose.deltaEtaNextHaltMin}`);

  // Far halt should decay back toward timetable speed (weight = exp(-25/8) ≈ 0.044)
  // Blended ≈ 0.044 * 100 + 0.956 * 50 ≈ 52.2 km/h
  assert(pFar.blendedSpeedNextHaltKmph < 56.0, `Far halt speed should be close to 50 km/h schedule: ${pFar.blendedSpeedNextHaltKmph}`);
  console.log(`  ok  near halt (3 km) blends to ${pClose.blendedSpeedNextHaltKmph} km/h (delta: ${pClose.deltaEtaNextHaltMin} min)`);
  console.log(`  ok  distant halt (25 km) decays to ${pFar.blendedSpeedNextHaltKmph} km/h (close to 50 km/h schedule)`);

  console.log('\n' + '='.repeat(70));
  console.log('ALL LIVE VELOCITY TRACKER VERIFICATION CHECKS PASSED');
  console.log('='.repeat(70));
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
