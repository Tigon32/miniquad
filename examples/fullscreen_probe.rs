use miniquad::*;

struct Stage {
    started: std::time::Instant,
}

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn draw(&mut self) {
        if self.started.elapsed() > std::time::Duration::from_secs(60) {
            eprintln!("fullscreen probe timed out");
            std::process::exit(2);
        }
    }

    fn key_down_event(&mut self, key: KeyCode, _: KeyMods, repeat: bool) {
        if repeat {
            return;
        }
        match key {
            KeyCode::F11 | KeyCode::F12 => {
                let fullscreen = key == KeyCode::F11;
                window::set_fullscreen(fullscreen);
                println!("requested fullscreen={}", fullscreen);
            }
            KeyCode::Escape => window::order_quit(),
            _ => {}
        }
    }
}

fn main() {
    miniquad::start(
        conf::Conf {
            window_title: format!("fullscreen_probe-{}", std::process::id()),
            window_width: 640,
            window_height: 480,
            fullscreen: false,
            ..Default::default()
        },
        || {
            Box::new(Stage {
                started: std::time::Instant::now(),
            })
        },
    );
}
