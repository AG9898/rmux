use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::time::Instant;

use crate::ralph::{
    self, RalphInstance, SpawnOpts,
};

#[derive(PartialEq)]
pub enum View {
    List,
    Log,
    Launch,
    Restart,
}

pub struct LaunchForm {
    pub fields: [String; 6], // prompt, model, dir, name, max_runs, marathon
    pub focused: usize,
    pub labels: [&'static str; 6],
}

impl LaunchForm {
    pub fn new() -> Self {
        Self {
            fields: [
                String::new(),              // prompt
                "opus".to_string(),         // model
                std::env::current_dir()     // dir
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                String::new(),              // name
                "0".to_string(),            // max_runs
                "false".to_string(),        // marathon
            ],
            focused: 0,
            labels: ["Prompt", "Model", "Directory", "Name", "Max runs", "Marathon"],
        }
    }

    pub fn reset(&mut self) {
        self.fields[0].clear();
        self.fields[1] = "opus".to_string();
        self.fields[2] = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        self.fields[3].clear();
        self.fields[4] = "0".to_string();
        self.fields[5] = "false".to_string();
        self.focused = 0;
    }
}

pub struct RestartForm {
    pub instance_name: String,
    pub max_runs: String,
}

pub struct App {
    pub view: View,
    pub instances: Vec<RalphInstance>,
    pub selected: usize,
    pub log_content: Vec<String>,
    pub log_scroll: usize,
    pub log_auto_follow: bool,
    pub log_file_pos: u64,
    pub log_instance_name: String,
    pub launch_form: LaunchForm,
    pub restart_form: RestartForm,
    pub should_quit: bool,
    pub status_msg: String,
    pub confirm_kill: Option<(String, Instant)>,
}

impl App {
    pub fn new() -> Self {
        let mut app = Self {
            view: View::List,
            instances: Vec::new(),
            selected: 0,
            log_content: Vec::new(),
            log_scroll: 0,
            log_auto_follow: true,
            log_file_pos: 0,
            log_instance_name: String::new(),
            launch_form: LaunchForm::new(),
            restart_form: RestartForm { instance_name: String::new(), max_runs: "0".to_string() },
            should_quit: false,
            status_msg: String::new(),
            confirm_kill: None,
        };
        app.refresh_instances();
        app
    }

    pub fn refresh_instances(&mut self) {
        self.instances = ralph::list_instances();
        if self.selected >= self.instances.len() && !self.instances.is_empty() {
            self.selected = self.instances.len() - 1;
        }
    }

    pub fn selected_instance(&self) -> Option<&RalphInstance> {
        self.instances.get(self.selected)
    }

    pub fn on_tick(&mut self) {
        match self.view {
            View::List => self.refresh_instances(),
            View::Log => self.refresh_log(),
            View::Launch | View::Restart => {}
        }
        // Expire kill confirmation after 3 seconds
        if let Some((_, when)) = &self.confirm_kill {
            if when.elapsed().as_secs() >= 3 {
                self.confirm_kill = None;
                self.status_msg.clear();
            }
        }
    }

    fn refresh_log(&mut self) {
        if let Some(inst) = self.instances.iter().find(|i| i.name == self.log_instance_name) {
            let path = inst.log_path.clone();
            let (new_lines, new_pos) = ralph::read_log_incremental(&path, self.log_file_pos);
            if !new_lines.is_empty() {
                self.log_content.extend(new_lines);
                self.log_file_pos = new_pos;
                if self.log_auto_follow {
                    self.log_scroll = self.log_content.len().saturating_sub(1);
                }
            }
        }
    }

    fn enter_log_view(&mut self) {
        let Some(inst) = self.instances.get(self.selected) else {
            return;
        };
        if !inst.has_log {
            self.status_msg = format!("No log file for {}", inst.name);
            return;
        }
        let name = inst.name.clone();
        let path = inst.log_path.clone();
        self.log_instance_name = name;
        self.log_content = ralph::read_log_tail(&path, 500);
        self.log_file_pos = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.log_auto_follow = true;
        self.log_scroll = self.log_content.len().saturating_sub(1);
        self.view = View::Log;
        self.status_msg.clear();
    }

    fn do_kill(&mut self, name: &str) {
        let name = name.to_string();
        match ralph::kill_instance(&name) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.confirm_kill = None;
        self.refresh_instances();
    }

    fn do_clean(&mut self) {
        let cleaned = ralph::clean_dead();
        if cleaned.is_empty() {
            self.status_msg = "Nothing to clean".to_string();
        } else {
            self.status_msg = format!("Cleaned: {}", cleaned.join(", "));
        }
        self.refresh_instances();
    }

    fn do_launch(&mut self) {
        let opts = SpawnOpts {
            prompt: self.launch_form.fields[0].clone(),
            model: self.launch_form.fields[1].clone(),
            dir: self.launch_form.fields[2].clone(),
            name: self.launch_form.fields[3].clone(),
            max_runs: self.launch_form.fields[4].parse().unwrap_or(0),
            marathon: self.launch_form.fields[5] == "true",
        };
        match ralph::spawn_ralph(&opts) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.launch_form.reset();
        self.view = View::List;
        self.refresh_instances();
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        // Ctrl-C always quits
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.should_quit = true;
            return;
        }

        match self.view {
            View::List => self.handle_list_key(key),
            View::Log => self.handle_log_key(key),
            View::Launch => self.handle_launch_key(key),
            View::Restart => self.handle_restart_key(key),
        }
    }

    fn handle_list_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('j') | KeyCode::Down => {
                if !self.instances.is_empty() {
                    self.selected = (self.selected + 1).min(self.instances.len() - 1);
                }
                self.confirm_kill = None;
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
                self.confirm_kill = None;
            }
            KeyCode::Enter | KeyCode::Char('l') => {
                self.enter_log_view();
            }
            KeyCode::Char('K') => {
                if let Some(inst) = self.selected_instance() {
                    let name = inst.name.clone();
                    if let Some((ref pending, _)) = self.confirm_kill {
                        if *pending == name {
                            self.do_kill(&name);
                            return;
                        }
                    }
                    self.status_msg = format!("Press K again to kill {}", name);
                    self.confirm_kill = Some((name, Instant::now()));
                }
            }
            KeyCode::Char('n') => {
                self.launch_form.reset();
                self.view = View::Launch;
                self.status_msg.clear();
                self.confirm_kill = None;
            }
            KeyCode::Char('c') => {
                self.do_clean();
                self.confirm_kill = None;
            }
            KeyCode::Char('R') => {
                if let Some(inst) = self.selected_instance() {
                    if inst.alive {
                        self.status_msg = format!("{} is still running — kill it first", inst.name);
                    } else {
                        self.restart_form.instance_name = inst.name.clone();
                        self.restart_form.max_runs = "0".to_string();
                        self.view = View::Restart;
                        self.status_msg.clear();
                        self.confirm_kill = None;
                    }
                }
            }
            KeyCode::Char('r') => {
                self.refresh_instances();
                self.status_msg = "Refreshed".to_string();
            }
            _ => {}
        }
    }

    fn handle_log_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc | KeyCode::Backspace => {
                self.view = View::List;
                self.status_msg.clear();
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.log_scroll = (self.log_scroll + 1).min(self.log_content.len().saturating_sub(1));
                self.log_auto_follow = false;
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.log_scroll = self.log_scroll.saturating_sub(1);
                self.log_auto_follow = false;
            }
            KeyCode::Char('g') => {
                self.log_scroll = 0;
                self.log_auto_follow = false;
            }
            KeyCode::Char('G') => {
                self.log_scroll = self.log_content.len().saturating_sub(1);
                self.log_auto_follow = true;
            }
            KeyCode::Char('K') => {
                let name = self.log_instance_name.clone();
                if let Some((ref pending, _)) = self.confirm_kill {
                    if *pending == name {
                        self.do_kill(&name);
                        return;
                    }
                }
                self.status_msg = format!("Press K again to kill {}", name);
                self.confirm_kill = Some((name, Instant::now()));
            }
            KeyCode::PageDown => {
                self.log_scroll = (self.log_scroll + 20).min(self.log_content.len().saturating_sub(1));
                self.log_auto_follow = false;
            }
            KeyCode::PageUp => {
                self.log_scroll = self.log_scroll.saturating_sub(20);
                self.log_auto_follow = false;
            }
            _ => {}
        }
    }

    fn handle_launch_key(&mut self, key: KeyEvent) {
        let focused = self.launch_form.focused;
        match key.code {
            KeyCode::Esc => {
                self.view = View::List;
                self.status_msg.clear();
            }
            KeyCode::Tab | KeyCode::Down => {
                self.launch_form.focused = (focused + 1) % 6;
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.launch_form.focused = if focused == 0 { 5 } else { focused - 1 };
            }
            KeyCode::Enter => {
                self.do_launch();
            }
            KeyCode::Char(' ') if focused == 5 => {
                // Toggle marathon
                self.launch_form.fields[5] = if self.launch_form.fields[5] == "true" {
                    "false".to_string()
                } else {
                    "true".to_string()
                };
            }
            KeyCode::Char(c) if focused != 5 => {
                self.launch_form.fields[focused].push(c);
            }
            KeyCode::Backspace if focused != 5 => {
                self.launch_form.fields[focused].pop();
            }
            _ => {}
        }
    }

    fn handle_restart_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.view = View::List;
                self.status_msg.clear();
            }
            KeyCode::Enter => {
                self.do_restart();
            }
            KeyCode::Char(c) if c.is_ascii_digit() => {
                if self.restart_form.max_runs == "0" {
                    self.restart_form.max_runs = c.to_string();
                } else {
                    self.restart_form.max_runs.push(c);
                }
            }
            KeyCode::Backspace => {
                self.restart_form.max_runs.pop();
                if self.restart_form.max_runs.is_empty() {
                    self.restart_form.max_runs = "0".to_string();
                }
            }
            _ => {}
        }
    }

    fn do_restart(&mut self) {
        let max_runs: u32 = self.restart_form.max_runs.parse().unwrap_or(0);
        let name = self.restart_form.instance_name.clone();
        match ralph::restart_instance(&name, max_runs) {
            Ok(msg) => self.status_msg = msg,
            Err(e) => self.status_msg = format!("Error: {}", e),
        }
        self.view = View::List;
        self.refresh_instances();
    }
}
