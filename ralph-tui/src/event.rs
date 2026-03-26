use crossterm::event::{self, Event, KeyEvent};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub enum AppEvent {
    Key(KeyEvent),
    Tick,
}

pub struct EventHandler {
    rx: mpsc::Receiver<AppEvent>,
}

impl EventHandler {
    pub fn new(tick_rate: Duration) -> Self {
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let mut last_tick = Instant::now();
            loop {
                let timeout = tick_rate.saturating_sub(last_tick.elapsed());
                if event::poll(timeout).unwrap_or(false) {
                    if let Ok(Event::Key(key)) = event::read() {
                        if tx.send(AppEvent::Key(key)).is_err() {
                            return;
                        }
                    }
                }
                if last_tick.elapsed() >= tick_rate {
                    if tx.send(AppEvent::Tick).is_err() {
                        return;
                    }
                    last_tick = Instant::now();
                }
            }
        });

        Self { rx }
    }

    pub fn next(&self) -> Result<AppEvent, mpsc::RecvError> {
        self.rx.recv()
    }
}
