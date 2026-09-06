-- 리드타임별 예약률: "며칠 전에 차는가".
-- D+0 은 이미 지나간 시각이 예약 불가로 잡히므로 계산에서 제외한다 (예약이 아니다).
-- 수요 압력이 셀수록 먼 날짜부터 찬다. 곡선의 높이보다 기울기가 신호다.
create table if not exists booking_lead (
  category      text   not null,
  sigungu       text   not null,
  observed_date date   not null,
  lead_days     int    not null,
  n_open        int    not null,
  n_booked      int    not null,
  fill_rate     numeric(6,4),
  primary key (category, sigungu, observed_date, lead_days)
);
