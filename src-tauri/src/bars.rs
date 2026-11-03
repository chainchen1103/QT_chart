//! The timeframes the app can show, and how each is made from OKX's own bars.
//!
//! OKX has 1s/5s/15s/30s, 1m/2m/3m/5m/15m/30m, 1H/2H/4H, 6H/12H, 1D/2D/3D/5D and 1W bars (from 6 hours up on UTC
//! boundaries with the "utc" names), but its WebSocket has no 5s/15s/30s channels: those are put together from
//! the 1s channel. Any other length (10s, 45m, 3H, 8H, 4D, 2W, …) is put together from the largest OKX bar that
//! divides it, on UTC boundaries (weeks from Monday), for history and for live candles alike.
//!
//! The app's names: a count and a unit, "10s", "45m", "3H", "6Hutc", "4Dutc", "2Wutc" (and the older "6H" /
//! "12H", OKX's own bars on Hong Kong boundaries, still accepted).

use crate::okx::Candle;
use std::collections::BTreeMap;

/// How one timeframe is loaded.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    /// Bar length in seconds.
    pub sec: i64,
    /// The OKX bar its history is made of, and how many of them make one bar (1: OKX's own).
    pub hist: &'static str,
    pub hist_n: i64,
    /// The OKX candle channel its live bars are made of, and how many of those make one bar.
    pub live: &'static str,
    pub live_n: i64,
    /// Bars start where (time - origin) is a multiple of `sec`.
    pub origin: i64,
}

/// OKX's own bars: name, seconds, and whether the WebSocket has a channel for it. Every one of them starts on
/// a multiple of its length counted from 1970-01-01 00:00 UTC (the week from Monday 1970-01-05).
const OKX: &[(&str, i64, bool)] = &[
    ("1s", 1, true),
    ("5s", 5, false),
    ("15s", 15, false),
    ("30s", 30, false),
    ("1m", 60, true),
    ("2m", 120, true),
    ("3m", 180, true),
    ("5m", 300, true),
    ("15m", 900, true),
    ("30m", 1800, true),
    ("1H", 3600, true),
    ("2H", 7200, true),
    ("4H", 14400, true),
    ("6Hutc", 21600, true),
    ("12Hutc", 43200, true),
    ("1Dutc", 86400, true),
    ("2Dutc", 172800, true),
    ("3Dutc", 259200, true),
    ("5Dutc", 432000, true),
    ("1Wutc", 604800, true),
];

/// OKX's 6- and 12-hour bars on Hong Kong boundaries (offered before the UTC ones; kept for saved charts).
const OKX_HK: &[(&str, i64)] = &[("6H", 21600), ("12H", 43200)];

const DAY: i64 = 86400;
const WEEK: i64 = 7 * DAY;
/// Monday 1970-01-05 00:00 UTC: weeks start here.
const MONDAY: i64 = 4 * DAY;
/// At most this many OKX bars make one bar (e.g. 59s from 1s bars, 23H from 1H bars).
pub const MAX_PARTS: i64 = 240;

/// The unit and count of an app timeframe name.
fn split(bar: &str) -> Option<(i64, &str)> {
    let digits = bar.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || digits > 4 || bar.starts_with('0') {
        return None;
    }
    let n: i64 = bar[..digits].parse().ok()?;
    Some((n, &bar[digits..]))
}

/// How to load `bar`, or None when it isn't a timeframe the app can show.
pub fn spec(bar: &str) -> Option<Spec> {
    if let Some(&(name, sec, ws)) = OKX.iter().find(|(name, _, _)| *name == bar) {
        let origin = if sec == WEEK { MONDAY } else { 0 };
        return Some(if ws {
            Spec { sec, hist: name, hist_n: 1, live: name, live_n: 1, origin }
        } else {
            Spec { sec, hist: name, hist_n: 1, live: "1s", live_n: sec, origin }
        });
    }
    if let Some(&(name, sec)) = OKX_HK.iter().find(|(name, _)| *name == bar) {
        return Some(Spec { sec, hist: name, hist_n: 1, live: name, live_n: 1, origin: 16 * 3600 });
    }
    let (n, unit) = split(bar)?;
    let (sec, origin, bases): (i64, i64, &[&str]) = match unit {
        "s" if n < 60 => (n, 0, &["30s", "15s", "5s", "1s"]),
        "m" if n < 1440 => (n * 60, 0, &["4H", "2H", "1H", "30m", "15m", "5m", "3m", "2m", "1m"]),
        "H" | "Hutc" if n < 24 => (n * 3600, 0, &["12Hutc", "6Hutc", "4H", "2H", "1H"]),
        "Dutc" if n <= 90 => (n * DAY, 0, &["1Dutc"]),
        "Wutc" if n <= 12 => (n * WEEK, MONDAY, &["1Wutc"]),
        _ => return None,
    };
    let (hist, hist_sec) = bases.iter().find_map(|b| {
        let s = OKX.iter().find(|(name, _, _)| name == b)?.1;
        (sec % s == 0).then_some((*b, s))
    })?;
    let hist_n = sec / hist_sec;
    if hist_n > MAX_PARTS {
        return None;
    }
    // the WebSocket has no 5s/15s/30s channels: live bars come from 1s
    let (live, live_n) = if hist_sec < 60 && hist != "1s" { ("1s", sec) } else { (hist, hist_n) };
    if live_n > MAX_PARTS {
        return None;
    }
    Some(Spec { sec, hist, hist_n, live, live_n, origin })
}

impl Spec {
    /// Start of the bar that contains time `t` (UTC seconds).
    pub fn start_of(&self, t: i64) -> i64 {
        self.origin + (t - self.origin).div_euclid(self.sec) * self.sec
    }
}

/// Bars of `spec` from OKX bars `part_sec` long (oldest first, any gaps). Every bar but the newest counts as
/// closed; the newest one when its last part has closed at its end. `drop_partial`: the oldest bar is left out
/// when its first part isn't there (it would be missing the start of the bar).
pub fn group(spec: &Spec, parts: &[Candle], part_sec: i64, drop_partial: bool) -> Vec<Candle> {
    let mut out: Vec<Candle> = Vec::new();
    let mut last_part: Option<&Candle> = None;
    for p in parts {
        let start = spec.start_of(p.time);
        match out.last_mut() {
            Some(bar) if bar.time == start => {
                bar.high = bar.high.max(p.high);
                bar.low = bar.low.min(p.low);
                bar.close = p.close;
                bar.volume += p.volume;
            }
            _ => out.push(Candle { time: start, confirmed: true, ..p.clone() }),
        }
        last_part = Some(p);
    }
    if let (Some(bar), Some(p)) = (out.last_mut(), last_part) {
        bar.confirmed = p.confirmed && p.time + part_sec >= bar.time + spec.sec;
    }
    if drop_partial && parts.first().is_some_and(|p| spec.start_of(p.time) != p.time) && !out.is_empty() {
        out.remove(0);
    }
    out
}

/// The live bar of a timeframe made of several OKX bars: the parts of the bar now forming, as they come in.
#[derive(Debug, Default)]
pub struct Builder {
    start: i64,
    parts: BTreeMap<i64, Candle>,
    /// Its earlier parts are in (loaded at the start, or the bar was seen from its first part on).
    complete: bool,
}

impl Builder {
    fn summary(&self, spec: &Spec, part_sec: i64) -> Option<Candle> {
        let mut it = self.parts.values();
        let first = it.next()?;
        let mut bar = Candle { time: self.start, ..first.clone() };
        for p in it {
            bar.high = bar.high.max(p.high);
            bar.low = bar.low.min(p.low);
            bar.close = p.close;
            bar.volume += p.volume;
        }
        let last = self.parts.values().next_back()?;
        bar.confirmed = last.confirmed && last.time + part_sec >= self.start + spec.sec;
        Some(bar)
    }

    /// A live part (an OKX candle of `spec.live`). Returns the bars to send: the one that just ended (when a
    /// new one starts) and the one forming, once its earlier parts are in.
    pub fn push(&mut self, spec: &Spec, part_sec: i64, c: Candle) -> Vec<Candle> {
        let start = spec.start_of(c.time);
        let mut out = Vec::new();
        if start < self.start {
            return out; // late part of a bar already done
        }
        if start > self.start {
            if self.complete {
                if let Some(mut done) = self.summary(spec, part_sec) {
                    done.confirmed = true;
                    out.push(done);
                }
            }
            // a bar seen from its start has nothing missing (parts without trades simply never come)
            self.complete = self.start != 0 || c.time == start;
            self.start = start;
            self.parts.clear();
        }
        self.parts.insert(c.time, c);
        if self.complete {
            out.extend(self.summary(spec, part_sec));
        }
        out
    }

    /// Recent parts from REST (oldest first), so the bar forming has its start: they fill what the live feed
    /// hasn't sent (its own parts are newer). Returns the bar forming.
    pub fn fill(&mut self, spec: &Spec, part_sec: i64, recent: &[Candle]) -> Option<Candle> {
        let newest = recent.last()?;
        if self.start == 0 {
            self.start = spec.start_of(newest.time);
        }
        for p in recent.iter().filter(|p| spec.start_of(p.time) == self.start) {
            self.parts.entry(p.time).or_insert_with(|| p.clone());
        }
        self.complete = true;
        self.summary(spec, part_sec)
    }

    #[cfg(test)]
    pub fn complete(&self) -> bool {
        self.complete
    }
}

/// Seconds of an OKX bar (0 for a name OKX doesn't have).
pub fn okx_sec(name: &str) -> i64 {
    OKX.iter().map(|&(n, s, _)| (n, s)).chain(OKX_HK.iter().copied()).find(|&(n, _)| n == name).map_or(0, |(_, s)| s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(time: i64, o: f64, h: f64, l: f64, cl: f64, v: f64, confirmed: bool) -> Candle {
        Candle { time, open: o, high: h, low: l, close: cl, volume: v, confirmed }
    }

    #[test]
    fn names_and_sources() {
        let s = spec("15m").unwrap();
        assert_eq!((s.sec, s.hist, s.hist_n, s.live, s.live_n), (900, "15m", 1, "15m", 1));
        let s = spec("5s").unwrap(); // REST has 5s bars, the WebSocket doesn't
        assert_eq!((s.hist, s.hist_n, s.live, s.live_n), ("5s", 1, "1s", 5));
        let s = spec("10s").unwrap();
        assert_eq!((s.sec, s.hist, s.hist_n, s.live, s.live_n), (10, "5s", 2, "1s", 10));
        let s = spec("45m").unwrap();
        assert_eq!((s.sec, s.hist, s.hist_n, s.live, s.live_n), (2700, "15m", 3, "15m", 3));
        let s = spec("3H").unwrap();
        assert_eq!((s.hist, s.hist_n), ("1H", 3));
        let s = spec("8H").unwrap();
        assert_eq!((s.hist, s.hist_n), ("4H", 2));
        let s = spec("18Hutc").unwrap();
        assert_eq!((s.hist, s.hist_n), ("6Hutc", 3));
        let s = spec("4Dutc").unwrap();
        assert_eq!((s.hist, s.hist_n, s.origin), ("1Dutc", 4, 0));
        let s = spec("2Wutc").unwrap();
        assert_eq!((s.hist, s.hist_n, s.origin), ("1Wutc", 2, MONDAY));
        assert_eq!(spec("6H").unwrap().origin, 16 * 3600);
        for bad in ["", "0m", "05m", "15M", "1d", "60s", "24H", "1440m", "13Wutc", "m", "1x", "99999m", "7s0"] {
            assert!(spec(bad).is_none(), "{bad}");
        }
        // too many parts: 239 one-minute bars is fine, 241 seconds can't be made of 1s bars
        assert!(spec("239m").is_some());
    }

    #[test]
    fn groups_history() {
        let s = spec("3H").unwrap();
        let h = 3600;
        let parts = vec![
            c(2 * h, 10.0, 11.0, 9.0, 10.5, 1.0, true), // the end of the bar 0:00–3:00: left out
            c(3 * h, 10.5, 12.0, 10.0, 11.0, 2.0, true),
            c(4 * h, 11.0, 13.0, 10.5, 12.5, 3.0, true),
            c(5 * h, 12.5, 12.6, 8.0, 9.0, 4.0, true),
            c(6 * h, 9.0, 9.5, 8.5, 9.2, 5.0, false), // forming
        ];
        let out = group(&s, &parts, h, true);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], c(3 * h, 10.5, 13.0, 8.0, 9.0, 9.0, true));
        assert_eq!(out[1], c(6 * h, 9.0, 9.5, 8.5, 9.2, 5.0, false));
        // a newest bar whose last part closed at its end is closed
        let done = group(&s, &parts[1..4], h, true);
        assert!(done.last().unwrap().confirmed);
        // weeks from Monday
        let w = spec("2Wutc").unwrap();
        assert_eq!(w.start_of(MONDAY + 3 * WEEK + 5), MONDAY + 2 * WEEK);
    }

    #[test]
    fn builds_live_bars() {
        let s = spec("10s").unwrap(); // from 1s parts
        let mut b = Builder::default();
        // joined in the middle of a bar: nothing until its start is filled in
        assert!(b.push(&s, 1, c(103, 5.0, 5.0, 5.0, 5.0, 1.0, false)).is_empty());
        let now = b.fill(&s, 1, &[c(100, 4.0, 4.5, 3.9, 4.2, 2.0, true), c(101, 4.2, 4.3, 4.1, 4.3, 1.0, true), c(103, 5.0, 5.0, 5.0, 5.0, 0.5, false)]).unwrap();
        assert_eq!(now, c(100, 4.0, 5.0, 3.9, 5.0, 4.0, false)); // its own part 103 kept over the older REST copy
        let out = b.push(&s, 1, c(109, 5.0, 6.0, 5.0, 6.0, 1.0, true));
        assert_eq!(out, vec![c(100, 4.0, 6.0, 3.9, 6.0, 5.0, true)]); // the last second closed: the bar is done
        // the next bar, seen from a later part: the earlier seconds had no trades
        let out = b.push(&s, 1, c(112, 6.1, 6.2, 6.0, 6.2, 1.0, false));
        assert_eq!(out.len(), 2);
        assert!(out[0].confirmed && out[0].time == 100);
        assert_eq!(out[1], c(110, 6.1, 6.2, 6.0, 6.2, 1.0, false));
        assert!(b.complete());
    }
}
