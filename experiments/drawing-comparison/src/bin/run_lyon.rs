//! Native driver for the `lyon` backend: runs the reference
//! workload `repeat` times (default 5, matching the Performance proof
//! skill's "modest" paired-repeat guidance for a shared, possibly noisy
//! host) and prints one JSON report line to stdout.

use std::time::Instant;

fn main() {
    let repeat: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    let mut timings = Vec::with_capacity(repeat);
    let mut last_result = None;
    for _ in 0..repeat {
        let start = Instant::now();
        let result = drawing_comparison::lyon_adapter::run();
        timings.push(start.elapsed().as_nanos());
        last_result = Some(result);
    }

    drawing_comparison::print_report("lyon", &timings, &last_result.unwrap());
}
